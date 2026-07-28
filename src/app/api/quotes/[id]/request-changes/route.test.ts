// Tests for POST /api/quotes/[id]/request-changes (#83 Phase 1, Slice B).
// The customer asks for changes with a note. The route:
//   - validates the UUID (400) + the body (note required, trimmed, capped → 400);
//   - only allows it when the status permits (changes_requested is reachable
//     from sent/viewed per quoteStatus.ts, NOT approved/booked → 409);
//   - stamps status='changes_requested';
//   - best-effort staff email so staff can edit + resend.
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
    view_only: false,
    ...overrides,
  };
}

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
  hl.configured.value = false;
});

describe('POST /api/quotes/[id]/request-changes', () => {
  it('requests changes on a sent quote — stamps status=changes_requested', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ note: '  Can we add the garage roofline?  ' }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('changes_requested');
    expect(updatePayloads[0].status).toBe('changes_requested');
  });

  it('requests changes on a viewed quote', async () => {
    const { client } = makeSb(baseQuote({ viewed_at: '2026-06-26T00:00:00Z', status: 'viewed' }));
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'Different color please' }), { params });
    expect(res.status).toBe(200);
  });

  // #176 — a staff-flagged browse-only quote can never request changes either.
  it('409s (view-only) when the quote is flagged view-only', async () => {
    const { client, updatePayloads } = makeSb(baseQuote({ view_only: true }));
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'Different color please' }), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('view-only');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects a missing note → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(400);
  });

  it('rejects a blank/whitespace note → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ note: '   ' }), { params });
    expect(res.status).toBe(400);
  });

  it('rejects an over-long note (>2000 chars) → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'x'.repeat(2001) }), { params });
    expect(res.status).toBe(400);
  });

  it('rejects a bad UUID → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'nope' }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(null, true), { params });
    expect(res.status).toBe(400);
  });

  it('refuses to request changes on a booked quote → 409', async () => {
    const { client } = makeSb(
      baseQuote({ deposit_paid_at: '2026-06-26T00:00:00Z', status: 'booked' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'too late' }), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });

  it('refuses to request changes on an approved quote → 409', async () => {
    const { client } = makeSb(
      baseQuote({ customer_approved_at: '2026-06-26T00:00:00Z', status: 'approved' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'wait' }), { params });
    expect(res.status).toBe(409);
  });

  it('404s a missing quote', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'whatever' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the guarded update wins no rows (already moved on)', async () => {
    const { client } = makeSb(baseQuote(), []);
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'race' }), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });

  it('fires a best-effort staff email when HighLevel is configured', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ note: 'Add garage' }), { params });
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

    const res = await POST(makeReq({ note: 'Add garage' }), { params });
    expect(res.status).toBe(200);

    delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  });
});
