// Tests for POST /api/quotes/[id]/view (#68 customer-viewed read receipt).
// The route records a customer opening /portal/[id] and emails staff. It must
// distinguish a STAFF preview from an actual CUSTOMER open: since #81, a logged-in
// operator carries a Supabase session (getOperator() != null) while a customer has
// none. A staff view is skipped entirely — no DB write, no event row, no email —
// so the view_count / activity feed / staff notification only reflect real customers.
//
// Supabase, HighLevel, and getOperator mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl, op } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    configured: { value: true },
    sendEmail: vi.fn(async () => ({})),
  },
  // The operator getOperator() resolves to: null = a customer, an object = staff.
  op: { current: null as unknown },
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

vi.mock('@/lib/auth/supabaseServer', () => ({
  getOperator: async () => op.current,
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
    viewed_at: null,
    view_count: 0,
    ...overrides,
  };
}

// Models the view route's two awaited writes: `.update().eq()` (the stamp) and
// `.insert()` (the event-log row), plus the `.select().eq().single()` fetch.
function makeSb(
  quote: Record<string, unknown> | null,
  opts: { stampError?: { message: string } | null; eventError?: { message: string } | null } = {},
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const insertPayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  let mode: 'update' | 'insert' | null = null;
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      updatePayloads.push(payload);
      return builder;
    },
    insert: (payload: Record<string, unknown>) => {
      mode = 'insert';
      insertPayloads.push(payload);
      return builder;
    },
    then: (resolve: (v: unknown) => void) => {
      const res =
        mode === 'update'
          ? { error: opts.stampError ?? null }
          : mode === 'insert'
            ? { error: opts.eventError ?? null }
            : { data: quote, error: null };
      mode = null;
      resolve(res);
    },
  });
  return { client: builder, updatePayloads, insertPayloads };
}

function makeReq(): NextRequest {
  return {
    json: async () => ({}),
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com' },
  } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = false;
  op.current = null;
  delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
});

describe('POST /api/quotes/[id]/view — customer view (no operator session)', () => {
  it('records the view on a sent quote — stamps + appends an event row', async () => {
    const { client, updatePayloads, insertPayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.viewCount).toBe(1);
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0].view_count).toBe(1);
    expect(updatePayloads[0].last_viewed_at).toBeTruthy();
    expect(insertPayloads).toHaveLength(1);
    expect(insertPayloads[0].quote_id).toBe(ID);
  });

  it('emails staff when HighLevel is configured', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips an unsent quote (no-op) — not a customer view yet', async () => {
    const { client, updatePayloads } = makeSb(baseQuote({ quote_sent_at: null }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('not-sent');
    expect(updatePayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('rejects a bad UUID → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/quotes/[id]/view — staff view (operator session present)', () => {
  it('is skipped: no DB write, no event row, no staff email', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    op.current = { id: 'op-1', email: 'staff@yulelovelights.com', role: 'operator', name: 'Sam' };
    const { client, updatePayloads, insertPayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.skipped).toBe('staff');
    expect(updatePayloads).toHaveLength(0);
    expect(insertPayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('an admin operator is also treated as staff', async () => {
    op.current = { id: 'op-2', email: 'admin@yulelovelights.com', role: 'admin', name: 'Admin' };
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(json.skipped).toBe('staff');
    expect(updatePayloads).toHaveLength(0);
  });
});
