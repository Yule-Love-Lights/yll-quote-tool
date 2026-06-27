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
