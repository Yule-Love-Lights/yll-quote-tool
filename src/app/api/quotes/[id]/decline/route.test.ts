// Tests for POST /api/quotes/[id]/decline (#83 Phase 1, Slice B).
// The customer declines their quote with a reason. The route:
//   - validates the UUID (400 on a bad id) + the body (reason required,
//     trimmed, length-capped → 400);
//   - only allows the decline when the current status permits it
//     (declinable from sent/viewed/approved, NOT from booked → 409);
//   - stamps status='declined' + decline_reason;
//   - best-effort staff email (never fatal).
//
// Supabase + HighLevel mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    configured: { value: true },
    sendEmail: vi.fn(async () => ({})),
    updateOpportunity: vi.fn(async () => ({ id: 'opp_1' })),
    findOpportunityForContact: vi.fn(async () => null as { id: string } | null),
    upsertContactCustomField: vi.fn(async () => undefined),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));

vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  sendEmail: hl.sendEmail,
  updateOpportunity: hl.updateOpportunity,
  findOpportunityForContact: hl.findOpportunityForContact,
  upsertContactCustomField: hl.upsertContactCustomField,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function baseQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    customer_name: 'Jordan Smith',
    customer_address: '1 Main St',
    customer_phone: '+15555550123',
    customer_email: 'jordan@example.com',
    highlevel_contact_id: null,
    quote_sent_at: '2026-06-25T00:00:00Z',
    customer_approved_at: null,
    deposit_paid_at: null,
    viewed_at: null,
    status: 'sent',
    view_only: false,
    ...overrides,
  };
}

// Fake Supabase: read = from().select().eq().single(); the guarded status
// update = from().update().eq().or().is().select() (returns affected rows); the
// `updateRows` arg controls what that guarded update returns (the race winner).
function makeSb(
  quote: Record<string, unknown> | null,
  updateRows: Array<{ id: string }> | null = [{ id: ID }],
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  let isUpdate = false;
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      isUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    or: () => builder,
    is: () => builder,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    then: (resolve: (v: unknown) => void) => {
      const res = isUpdate ? { data: updateRows, error: null } : { data: quote, error: null };
      isUpdate = false;
      resolve(res);
    },
  });
  return { client: builder, updatePayloads };
}

function makeReq(body: unknown, badJson = false): NextRequest {
  return {
    json: async () => {
      if (badJson) throw new Error('bad json');
      return body;
    },
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com' },
  } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = false; // no messaging unless a test opts in
});

describe('POST /api/quotes/[id]/decline', () => {
  it('declines a sent quote — stamps status=declined + decline_reason', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ reason: '  Too expensive this year  ' }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('declined');
    expect(updatePayloads[0].status).toBe('declined');
    // reason is trimmed before storage
    expect(updatePayloads[0].decline_reason).toBe('Too expensive this year');
  });

  it('declines a viewed quote', async () => {
    const { client } = makeSb(
      baseQuote({ viewed_at: '2026-06-26T00:00:00Z', status: 'viewed' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Changed my mind' }), { params });
    expect(res.status).toBe(200);
  });

  it('declines a changes-requested quote', async () => {
    const { client } = makeSb(baseQuote({ status: 'changes_requested' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'On second thought, no' }), { params });
    expect(res.status).toBe(200);
  });

  // Slice A's transition table deliberately makes a signed/approved quote
  // NON-declinable by the customer (the signature attests to the agreement) —
  // approved → {booked, cancelled} only. A would-be decline is refused 409.
  it('refuses to decline an approved (signed) quote → 409', async () => {
    const { client } = makeSb(
      baseQuote({ customer_approved_at: '2026-06-26T00:00:00Z', status: 'approved' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Changed my mind' }), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });

  // #176 — a staff-flagged browse-only quote can never be declined either.
  it('409s (view-only) when the quote is flagged view-only', async () => {
    const { client, updatePayloads } = makeSb(baseQuote({ view_only: true }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Changed my mind' }), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('view-only');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects a missing reason → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(400);
  });

  it('rejects a blank/whitespace reason → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ reason: '   ' }), { params });
    expect(res.status).toBe(400);
  });

  it('rejects an over-long reason (>2000 chars) → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'x'.repeat(2001) }), { params });
    expect(res.status).toBe(400);
  });

  it('rejects a bad UUID → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'nope' }), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(null, true), { params });
    expect(res.status).toBe(400);
  });

  it('refuses to decline a booked quote → 409', async () => {
    const { client } = makeSb(
      baseQuote({ deposit_paid_at: '2026-06-26T00:00:00Z', status: 'booked' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'too late' }), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });

  it('404s a missing quote', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'whatever' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the guarded update wins no rows (already moved on)', async () => {
    const { client } = makeSb(baseQuote(), []);
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'race' }), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });

  it('fires a best-effort staff email when HighLevel is configured', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);

    delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  });

  it('still 200s when the staff email throws (best-effort)', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);

    delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  });
});

describe('POST /api/quotes/[id]/decline — GHL card move (#GHL pipeline sync)', () => {
  beforeEach(() => {
    hl.configured.value = true;
  });

  it('moves an already-linked card to the holiday Declined stage', async () => {
    const { client } = makeSb(baseQuote({ highlevel_opportunity_id: 'opp_1', service_type: 'holiday' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_1', {
      pipelineStageId: '92090ef4-b8d6-4d68-b0f6-b4462e60d658',
    });
  });

  it('a permanent quote moves the card to Abandoned (no real Declined stage in that pipeline)', async () => {
    const { client } = makeSb(baseQuote({ highlevel_opportunity_id: 'opp_perm', service_type: 'permanent' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_perm', {
      pipelineStageId: '5a5f2e27-6dde-452c-8619-df1871908c8c', // Abandoned
    });
  });

  it('looks up the card via the contact when no opportunity id is linked', async () => {
    hl.findOpportunityForContact.mockResolvedValueOnce({ id: 'found_opp' });
    const { client } = makeSb(
      baseQuote({ highlevel_opportunity_id: null, highlevel_contact_id: 'contact_1', service_type: 'event' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.findOpportunityForContact).toHaveBeenCalledWith('contact_1', 'YfCi5jy8Alc3oD5AfXmV');
    expect(hl.updateOpportunity).toHaveBeenCalledWith('found_opp', {
      pipelineStageId: '239ec700-bd21-49ba-9691-f0a9b44637b0',
    });
  });

  it('never CREATES a card — no opportunity and no contact match means no GHL call at all', async () => {
    const { client } = makeSb(baseQuote({ highlevel_opportunity_id: null, highlevel_contact_id: null }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('legacy_rebook (#156): moves a legacy rebook card to the Neighbors Declined stage, never the holiday one', async () => {
    const { client } = makeSb(
      baseQuote({ highlevel_opportunity_id: 'opp_1', service_type: 'holiday', legacy_rebook: true }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_1', {
      pipelineStageId: 'abe1ed98-1091-4b70-bc6f-ae786cbea333', // Declined for 2025 (Neighbors)
    });
  });

  it('never touches GHL for a TEST quote', async () => {
    const { client } = makeSb(baseQuote({ highlevel_opportunity_id: 'opp_1', is_test: true }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.findOpportunityForContact).not.toHaveBeenCalled();
  });

  it('does not fail the decline when the GHL stage move throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb(baseQuote({ highlevel_opportunity_id: 'opp_1' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('GHL decline stage move failed'),
      expect.anything(),
    );
    err.mockRestore();
  });
});

describe('POST /api/quotes/[id]/decline — decline clears the quote-link field', () => {
  beforeEach(() => {
    hl.configured.value = true;
  });

  it('clears the per-type quote-link field on the contact after declining', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT = 'field_quote_link_permanent';
    const { client } = makeSb(
      baseQuote({ highlevel_contact_id: 'contact_1', highlevel_opportunity_id: 'opp_perm', service_type: 'permanent' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'field_quote_link_permanent', '');

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT;
  });

  it('still clears the field when the card move found no card (card id stale)', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    const { client } = makeSb(
      baseQuote({ highlevel_contact_id: 'contact_1', highlevel_opportunity_id: null, service_type: 'holiday' }),
    );
    sbRef.current = client;
    hl.findOpportunityForContact.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'field_quote_link_holiday', '');

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });

  it('still clears the field when the card move itself throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb(
      baseQuote({ highlevel_contact_id: 'contact_1', highlevel_opportunity_id: 'opp_1', service_type: 'holiday' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'field_quote_link_holiday', '');

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
    vi.restoreAllMocks();
  });

  it('skips silently when the per-type field env var is unset', async () => {
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
    const { client } = makeSb(baseQuote({ highlevel_contact_id: 'contact_1', service_type: 'holiday' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('does not fail the decline when the field clear throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    hl.upsertContactCustomField.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb(baseQuote({ highlevel_contact_id: 'contact_1', service_type: 'holiday' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('quote-link custom field clear failed'),
      expect.anything(),
    );

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
    err.mockRestore();
  });

  it('never clears the field for a TEST quote', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    const { client } = makeSb(baseQuote({ highlevel_contact_id: 'contact_1', is_test: true, service_type: 'holiday' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });

  it('legacy_rebook (#156): CRITICAL — clears the NEIGHBOR field, never falls back to the holiday field when unset', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR;
    const { client } = makeSb(
      baseQuote({ highlevel_contact_id: 'contact_1', service_type: 'holiday', legacy_rebook: true }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    // Never stamps/clears the holiday field for a legacy rebook.
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });

  it('legacy_rebook (#156): clears the NEIGHBOR field when its env var IS configured', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR = 'field_quote_link_neighbor';
    const { client } = makeSb(
      baseQuote({ highlevel_contact_id: 'contact_1', service_type: 'holiday', legacy_rebook: true }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact_1', 'field_quote_link_neighbor', '');

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR;
  });

  it('skips the clear entirely when HighLevel is not configured', async () => {
    hl.configured.value = false;
    process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY = 'field_quote_link_holiday';
    const { client } = makeSb(baseQuote({ highlevel_contact_id: 'contact_1', service_type: 'holiday' }));
    sbRef.current = client;

    const res = await POST(makeReq({ reason: 'Budget' }), { params });
    expect(res.status).toBe(200);
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();

    delete process.env.HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY;
  });
});
