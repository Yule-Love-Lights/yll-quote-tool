// Tests for POST /api/quotes/[id]/staff-abandon (#235).
//
// Operator archives a quote that went cold — never approved, never declined:
//   draft | sent | viewed | changes_requested → abandoned
//   writes status='abandoned', approval_snapshot.staffAbandoned = { by, at, reason }
//
// Money/status-safety guards:
//   - illegal status transitions are blocked (409) — approved/booked/terminal
//   - the write is GUARDED: .or(abandonable).is('deposit_paid_at', null) — a
//     concurrent approval/booking can't be raced past (0 rows ⇒ 409)
//   - already abandoned → idempotent 200 { alreadyAbandoned: true }, no write
//   - reason is optional (empty → null in the snapshot); >2000 chars → 400
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

// Chainable Supabase mock — mirrors staff-decline's route.test.ts harness.
//   maybeSingle() → the quote row
//   .update().eq().or().is().select() terminates via .then() → updateRows
//
// #176 TOCTOU: the write also carries `.eq('view_only', false)`. The mock
// evaluates that filter against the row's LIVE view_only (which may differ
// from the READ view_only, to simulate a concurrent staff toggle landing
// between the fast-path read and this write).
function makeSb(
  quote: Record<string, unknown> | null,
  updateRows: Array<{ id: string }> | null = [{ id: ID }],
  liveViewOnly?: boolean,
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const orArgs: string[] = [];
  let pendingIsUpdate = false;
  let viewOnlyFilterPasses: boolean | null = null;
  const effectiveViewOnly =
    liveViewOnly !== undefined ? liveViewOnly : quote ? Boolean(quote.view_only) : false;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      pendingIsUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: (col: string, val: unknown) => {
      if (col === 'view_only') {
        viewOnlyFilterPasses = effectiveViewOnly === val;
      }
      return builder;
    },
    or: (f: string) => {
      orArgs.push(f);
      return builder;
    },
    is: () => builder,
    maybeSingle: async () => ({ data: quote, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const isUpd = pendingIsUpdate;
      pendingIsUpdate = false;
      const excluded = isUpd && viewOnlyFilterPasses === false;
      viewOnlyFilterPasses = null;
      resolve(isUpd ? { data: excluded ? [] : updateRows, error: null } : { data: quote, error: null });
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
  view_only: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ email: 'operator@example.com' });
  hl.configured.value = false; // no GHL card move unless a test opts in
});

describe('POST /api/quotes/[id]/staff-abandon', () => {
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

  it('abandons a sent quote — writes status=abandoned, staffAbandoned marker, guarded write', async () => {
    const { client, updatePayloads, orArgs } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'No reply after 3 follow-ups' }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('abandoned');
    expect(json.staff).toBe(true);

    const payload = updatePayloads[0];
    expect(payload.status).toBe('abandoned');
    expect(payload.decline_reason).toBeUndefined(); // no dedicated reason column for abandon
    const snap = payload.approval_snapshot as { staffAbandoned: { by: string | null; at: string; reason: string | null } };
    expect(snap.staffAbandoned.by).toBe('operator@example.com');
    expect(typeof snap.staffAbandoned.at).toBe('string');
    expect(snap.staffAbandoned.reason).toBe('No reply after 3 follow-ups');
    // Guard: the write is filtered to still-abandonable rows.
    expect(orArgs[0]).toContain('status.in.(draft,sent,viewed,changes_requested)');
    expect(orArgs[0]).toContain('status.is.null');
  });

  it('abandons a draft quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: null, quote_sent_at: null });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'no' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('abandoned');
  });

  it('abandons a viewed quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'viewed', viewed_at: '2026-07-01T01:00:00Z' });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'no' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('abandoned');
  });

  it('abandons a changes_requested quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'changes_requested' });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'no' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('abandoned');
  });

  it('409s (illegal-transition) when the quote is approved — money already in motion', async () => {
    const { client, updatePayloads } = makeSb({
      ...BASE_SENT_QUOTE,
      status: 'approved',
      customer_approved_at: '2026-07-01T02:00:00Z',
      deposit_paid_at: null,
    });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('illegal-transition');
    expect(updatePayloads).toHaveLength(0);
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

  it('409s when the quote is already declined (terminal, not abandonable)', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'declined' });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('illegal-transition');
  });

  it('is idempotent when already abandoned — 200 alreadyAbandoned, no write', async () => {
    const { client, updatePayloads } = makeSb({ ...BASE_SENT_QUOTE, status: 'abandoned' });
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyAbandoned).toBe(true);
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

  it('stores a null snapshot reason when no reason is given', async () => {
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ reason: '' }), ctx());
    expect(res.status).toBe(200);
    const payload = updatePayloads[0];
    expect((payload.approval_snapshot as { staffAbandoned: { reason: unknown } }).staffAbandoned.reason).toBeNull();
  });

  it('tolerates a missing/invalid body (no reason) rather than 400', async () => {
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq(undefined), ctx()); // json() rejects
    expect(res.status).toBe(200);
    expect((updatePayloads[0].approval_snapshot as { staffAbandoned: { reason: unknown } }).staffAbandoned.reason).toBeNull();
  });

  it('400s when the reason exceeds the length cap', async () => {
    const { client } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x'.repeat(2001) }), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('reason-too-long');
  });

  it('records staffAbandoned.by as null when getOperator returns null (dormant gate)', async () => {
    getOperatorMock.mockResolvedValueOnce(null);
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as { staffAbandoned: { by: unknown } };
    expect(snap.staffAbandoned.by).toBeNull();
  });

  it('preserves existing approval_snapshot fields and adds staffAbandoned', async () => {
    const { client, updatePayloads } = makeSb({
      ...BASE_SENT_QUOTE,
      approval_snapshot: { version: 1, someOtherField: 'value' },
    });
    sbRef.current = client;
    await POST(makeReq({ reason: 'x' }), ctx());
    const snap = updatePayloads[0].approval_snapshot as Record<string, unknown>;
    expect(snap.someOtherField).toBe('value');
    expect(snap.staffAbandoned).toBeTruthy();
  });

  // #176 — a staff-flagged browse-only quote can never be staff-abandoned either.
  it('409s (view-only) when the quote is flagged view-only', async () => {
    const { client, updatePayloads } = makeSb({ ...BASE_SENT_QUOTE, view_only: true });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('view-only');
    expect(updatePayloads).toHaveLength(0);
  });

  // #176 TOCTOU: the read sees view_only=false (passes the fast-path check),
  // but a concurrent staff toggle flips it ON before the guarded write lands.
  it('does NOT abandon a quote toggled view-only between read and write (TOCTOU re-check)', async () => {
    const { client, updatePayloads } = makeSb(
      BASE_SENT_QUOTE,
      [{ id: ID }],
      true, // liveViewOnly: concurrent staff toggle turned it ON after the read
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();

    expect(updatePayloads).toHaveLength(1);
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });
});

describe('POST /api/quotes/[id]/staff-abandon — GHL card move (#235)', () => {
  beforeEach(() => {
    hl.configured.value = true;
  });

  it('moves an already-linked card to the holiday Abandoned stage', async () => {
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_1', {
      pipelineStageId: 'eb127233-055b-44fb-a942-cefd7d6bef1f', // ⛔Abandoned
    });
  });

  it('a permanent quote moves the card to its OWN Abandoned stage (not the now-repointed Declined one)', async () => {
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

  it('a Neighbors legacy rebook moves to the SAME stage as decline (no dedicated Abandoned in that pipeline)', async () => {
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
      pipelineStageId: 'abe1ed98-1091-4b70-bc6f-ae786cbea333', // Declined for 2026 (Neighbors)
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

  it('never touches GHL for a TEST quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_opportunity_id: 'opp_1', is_test: true });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('does not fail the abandon when the GHL stage move throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_opportunity_id: 'opp_1' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('abandoned');
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('GHL abandoned stage move failed'),
      expect.anything(),
    );
    err.mockRestore();
  });

  it('does NOT move a card when the abandon is a no-op idempotent replay (already abandoned)', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'abandoned', highlevel_opportunity_id: 'opp_1' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyAbandoned).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });
});

describe('POST /api/quotes/[id]/staff-abandon — clears the quote-link field', () => {
  beforeEach(() => {
    hl.configured.value = true;
  });

  it('clears the per-type quote-link field on the contact after abandoning', async () => {
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

  it('does not fail the abandon when the field clear throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    hl.upsertContactCustomField.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb({ ...BASE_SENT_QUOTE, highlevel_contact_id: 'contact_1', service_type: 'holiday' });
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('abandoned');
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
});
