// Tests for POST /api/quotes/[id]/staff-decline (#83 ops).
//
// Operator records a decline the customer gave OUTSIDE the tool (phone/text):
//   sent | viewed | changes_requested → declined
//   writes status='declined', decline_reason=<reason|marker>,
//   approval_snapshot.staffDeclined = { by, at, reason }
//
// Money/status-safety guards:
//   - illegal status transitions are blocked (409) — approved/booked/terminal
//   - the write is GUARDED: .or(declinable).is('deposit_paid_at', null) — a
//     concurrent approval/booking can't be raced past (0 rows ⇒ 409)
//   - already declined → idempotent 200 { alreadyDeclined: true }, no write
//   - reason is optional (empty → a staff marker is stored); >2000 chars → 400
//   - is_test → no real GHL/notify call (route makes none)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, getOperatorMock, sbRef, hl } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async () => null as { email: string | null } | null),
  sbRef: { current: null as unknown },
  hl: {
    configured: { value: false },
    updateOpportunity: vi.fn(async () => ({ id: 'opp_1' })),
    findOpportunityForContact: vi.fn(async () => null as { id: string } | null),
    upsertContactCustomField: vi.fn(async () => undefined),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  updateOpportunity: hl.updateOpportunity,
  findOpportunityForContact: hl.findOpportunityForContact,
  upsertContactCustomField: hl.upsertContactCustomField,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// A NextRequest stand-in. Pass a body to drive req.json(); omit it (or pass
// undefined) to simulate a missing/invalid body (json() rejects).
function makeReq(body?: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as unknown as NextRequest;
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

// Chainable Supabase mock.
//   maybeSingle() → the quote row
//   .update().eq().or().is().select() terminates via .then() → updateRows
function makeSb(
  quote: Record<string, unknown> | null,
  updateRows: Array<{ id: string }> | null = [{ id: ID }],
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const orArgs: string[] = [];
  let pendingIsUpdate = false;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      pendingIsUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    or: (f: string) => {
      orArgs.push(f);
      return builder;
    },
    is: () => builder,
    maybeSingle: async () => ({ data: quote, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const isUpd = pendingIsUpdate;
      pendingIsUpdate = false;
      resolve(isUpd ? { data: updateRows, error: null } : { data: quote, error: null });
    },
  });
  return { client: builder, updatePayloads, orArgs };
}

const BASE_SENT_QUOTE = {
  id: ID,
  status: 'sent' as const,
  quote_sent_at: '2026-07-01T00:00:00Z',
  viewed_at: null,
  customer_approved_at: null,
  deposit_paid_at: null,
  approval_snapshot: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ email: 'operator@example.com' });
  hl.configured.value = false; // no GHL card move unless a test opts in
});

describe('POST /api/quotes/[id]/staff-decline', () => {
  it('400s on an invalid UUID', async () => {
    const res = await POST(makeReq({ reason: 'x' }), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(404);
  });

  it('declines a sent quote — writes status=declined, decline_reason, staffDeclined marker, guarded write', async () => {
    const { client, updatePayloads, orArgs } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Went with a competitor' }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('declined');
    expect(json.staff).toBe(true);

    const payload = updatePayloads[0];
    expect(payload.status).toBe('declined');
    expect(payload.decline_reason).toBe('Went with a competitor');
    const snap = payload.approval_snapshot as { staffDeclined: { by: string | null; at: string; reason: string | null } };
    expect(snap.staffDeclined.by).toBe('operator@example.com');
    expect(typeof snap.staffDeclined.at).toBe('string');
    expect(snap.staffDeclined.reason).toBe('Went with a competitor');
    // Guard: the write is filtered to still-declinable rows (#124 adds draft + approved).
    expect(orArgs[0]).toContain('status.in.(draft,sent,viewed,approved,changes_requested)');
    expect(orArgs[0]).toContain('status.is.null');
  });

  it('declines a viewed quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'viewed', viewed_at: '2026-07-01T01:00:00Z' });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'no' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('declined');
  });

  it('declines a changes_requested quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'changes_requested' });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'no' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('declined');
  });

  it('#124: declines an APPROVED (unbooked) quote — customer backed out before paying the deposit', async () => {
    const { client, updatePayloads } = makeSb({
      ...BASE_SENT_QUOTE,
      status: 'approved',
      customer_approved_at: '2026-07-01T02:00:00Z',
      deposit_paid_at: null, // approved ⇒ no deposit; money-safe to decline
    });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'changed their mind' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('declined');
    expect(updatePayloads[0].status).toBe('declined');
  });

  it('#124: declines a DRAFT quote the customer declined before it was ever sent', async () => {
    const { client, updatePayloads } = makeSb({
      ...BASE_SENT_QUOTE,
      status: null, // a draft carries no persisted status; deriveStatus ⇒ 'draft'
      quote_sent_at: null,
      viewed_at: null,
      customer_approved_at: null,
    });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'never wanted it' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('declined');
    expect(updatePayloads[0].status).toBe('declined');
  });

  it('409s when the quote is booked (deposit paid)', async () => {
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      status: 'booked',
      customer_approved_at: '2026-07-01T02:00:00Z',
      deposit_paid_at: '2026-07-01T03:00:00Z',
    });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('illegal-transition');
  });

  it('is idempotent when already declined — 200 alreadyDeclined, no write', async () => {
    const { client, updatePayloads } = makeSb({ ...BASE_SENT_QUOTE, status: 'declined' });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyDeclined).toBe(true);
    expect(updatePayloads).toHaveLength(0);
  });

  it('handles a race (update returns 0 rows) as a 409', async () => {
    const { client } = makeSb(BASE_SENT_QUOTE, []); // [] = race loser
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });

  it('stores a default staff marker + null snapshot reason when no reason is given', async () => {
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ reason: '' }), ctx());
    expect(res.status).toBe(200);
    const payload = updatePayloads[0];
    expect(payload.decline_reason).toBe('Declined outside the tool (recorded by staff).');
    expect((payload.approval_snapshot as { staffDeclined: { reason: unknown } }).staffDeclined.reason).toBeNull();
  });

  it('tolerates a missing/invalid body (no reason) rather than 400', async () => {
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq(undefined), ctx()); // json() rejects
    expect(res.status).toBe(200);
    expect(updatePayloads[0].decline_reason).toBe('Declined outside the tool (recorded by staff).');
  });

  it('400s when the reason exceeds the length cap', async () => {
    const { client } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x'.repeat(2001) }), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('reason-too-long');
  });

  it('records staffDeclined.by as null when getOperator returns null (dormant gate)', async () => {
    getOperatorMock.mockResolvedValueOnce(null);
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as { staffDeclined: { by: unknown } };
    expect(snap.staffDeclined.by).toBeNull();
  });

  it('preserves existing approval_snapshot fields and adds staffDeclined', async () => {
    const { client, updatePayloads } = makeSb({
      ...BASE_SENT_QUOTE,
      approval_snapshot: { version: 1, someOtherField: 'value' },
    });
    sbRef.current = client;
    await POST(makeReq({ reason: 'x' }), ctx());
    const snap = updatePayloads[0].approval_snapshot as Record<string, unknown>;
    expect(snap.someOtherField).toBe('value');
    expect(snap.staffDeclined).toBeTruthy();
  });
});

describe('POST /api/quotes/[id]/staff-decline — GHL card move (#GHL pipeline sync)', () => {
  beforeEach(() => {
    hl.configured.value = true;
  });

  it('moves an already-linked card to the holiday Declined stage', async () => {
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_1', {
      pipelineStageId: '92090ef4-b8d6-4d68-b0f6-b4462e60d658',
    });
  });

  it('a permanent quote moves the card to Abandoned (no real Declined stage in that pipeline)', async () => {
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_opportunity_id: 'opp_perm',
      service_type: 'permanent',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_perm', {
      pipelineStageId: '5a5f2e27-6dde-452c-8619-df1871908c8c', // Abandoned
    });
  });

  it('never CREATES a card — no opportunity and no contact match means no GHL call at all', async () => {
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_opportunity_id: null,
      highlevel_contact_id: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('legacy_rebook (#156): moves a legacy rebook card to the Neighbors Declined stage, never the holiday one', async () => {
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
      legacy_rebook: true,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_1', {
      pipelineStageId: 'abe1ed98-1091-4b70-bc6f-ae786cbea333', // Declined for 2025 (Neighbors)
    });
  });

  it('never touches GHL for a TEST quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_opportunity_id: 'opp_1', is_test: true });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('does not fail the decline when the GHL stage move throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_opportunity_id: 'opp_1' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('declined');
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('GHL decline stage move failed'),
      expect.anything(),
    );
    err.mockRestore();
  });

  it('does NOT move a card when the decline is a no-op idempotent replay (already declined)', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'declined', highlevel_opportunity_id: 'opp_1' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyDeclined).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });
});

describe('POST /api/quotes/[id]/staff-decline — decline clears the quote-link field', () => {
  beforeEach(() => {
    hl.configured.value = true;
  });

  it('clears the per-type quote-link field on the contact after declining', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT = 'field_quote_link_event';
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_contact_id: 'contact_1',
      highlevel_opportunity_id: 'opp_evt',
      service_type: 'event',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'field_quote_link_event', '');

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT;
  });

  it('still clears the field when the card move found no card (card id stale)', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_contact_id: 'contact_1',
      highlevel_opportunity_id: null,
      service_type: 'holiday',
    });
    sbRef.current = client;
    hl.findOpportunityForContact.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'field_quote_link_holiday', '');

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });

  it('still clears the field when the card move itself throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_contact_id: 'contact_1',
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'field_quote_link_holiday', '');

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
    vi.restoreAllMocks();
  });

  it('skips silently when the per-type field env var is unset', async () => {
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_contact_id: 'contact_1', service_type: 'holiday' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('does not fail the decline when the field clear throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    hl.upsertContactCustomField.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_contact_id: 'contact_1', service_type: 'holiday' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('declined');
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('quote-link custom field clear failed'),
      expect.anything(),
    );

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
    err.mockRestore();
  });

  it('never clears the field for a TEST quote', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_contact_id: 'contact_1',
      is_test: true,
      service_type: 'holiday',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });

  it('skips the clear entirely when HighLevel is not configured', async () => {
    hl.configured.value = false;
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_contact_id: 'contact_1', service_type: 'holiday' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });

  it('legacy_rebook (#156): CRITICAL — clears the NEIGHBOR field, never falls back to the holiday field when unset', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR;
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_contact_id: 'contact_1',
      service_type: 'holiday',
      legacy_rebook: true,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });
});
