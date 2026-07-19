import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AmendmentTrailEntry } from '@/lib/amend';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AMENDED_AT = '2026-07-18T12:00:00.000Z';
const amendment: AmendmentTrailEntry = {
  amended_at: AMENDED_AT,
  by: 'staff:ops',
  reason: 'Added front wreaths',
  previous_total: 2000,
  new_total: 2400,
  previous_balance: 1000,
  new_balance: 1400,
  deposit_applied: 1000,
  delta: 400,
  line_item_changes: [],
  consent: { status: 'pending' },
};

function makeSb(quote: Record<string, unknown>, updatedRows: unknown[] = [{ id: ID }]) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const eqCalls: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {};
  let updating = false;
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      updating = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return builder;
    },
    single: async () => ({ data: quote, error: null }),
    then: (resolve: (value: unknown) => void) => {
      const value = updating ? { data: updatedRows, error: null } : { data: quote, error: null };
      updating = false;
      resolve(value);
    },
  });
  return { client: builder, updatePayloads, eqCalls };
}

function req(body: Record<string, unknown>): NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as NextRequest;
}

const cosmeticAmendment: AmendmentTrailEntry = {
  amended_at: '2026-07-18T12:10:00.000Z',
  by: 'staff:ops',
  reason: 'Added free spritzers',
  previous_total: 2400,
  new_total: 2400,
  previous_balance: 1400,
  new_balance: 1400,
  deposit_applied: 1000,
  delta: 0,
  line_item_changes: [{ id: 'free-spritzers', label: 'Free spritzers', change: 'added', price: 0 }],
};

const signature = { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith' };
const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => vi.clearAllMocks());

describe('POST /api/quotes/[id]/amend-consent', () => {
  it('rejects a malformed capability token before reading the quote', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT, signature }), {
      params: Promise.resolve({ id: 'not-a-quote-id' }),
    });
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('atomically records the customer signature on the latest amendment', async () => {
    const { client, updatePayloads, eqCalls } = makeSb({
      id: ID,
      status: 'booked',
      quote_sent_at: '2026-06-20T00:00:00.000Z',
      customer_approved_at: '2026-06-25T00:00:00.000Z',
      deposit_paid_at: '2026-07-01T00:00:00.000Z',
      approval_snapshot: { amendments: [amendment] },
    });
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT, signature }), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(eqCalls).toContainEqual([
      'approval_snapshot',
      JSON.stringify({ amendments: [amendment] }),
    ]);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments[0].consent).toMatchObject({
      status: 'accepted',
      signature: { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith' },
    });
  });

  it('signs the pending price change while preserving a later cosmetic entry', async () => {
    const originalSnapshot = { amendments: [amendment, cosmeticAmendment] };
    const { client, updatePayloads, eqCalls } = makeSb({
      id: ID,
      status: 'booked',
      quote_sent_at: '2026-06-20T00:00:00.000Z',
      customer_approved_at: '2026-06-25T00:00:00.000Z',
      deposit_paid_at: '2026-07-01T00:00:00.000Z',
      approval_snapshot: originalSnapshot,
    });
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT, signature }), ctx);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(['approval_snapshot', JSON.stringify(originalSnapshot)]);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments).toHaveLength(2);
    expect(snapshot.amendments[0].consent?.status).toBe('accepted');
    expect(snapshot.amendments[1]).toEqual(cosmeticAmendment);
  });

  it('rejects a missing signature before writing', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects an oversized signature value before writing (snapshot is CAS-matched by serialized size)', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(
      req({
        amendedAt: AMENDED_AT,
        signature: { name: 'Jordan Smith', kind: 'drawn', value: `data:image/png;base64,${'A'.repeat(2_000)}` },
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-consent');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects an outdated amendment id', async () => {
    const { client, updatePayloads } = makeSb({
      id: ID,
      status: 'booked',
      quote_sent_at: '2026-06-20T00:00:00.000Z',
      customer_approved_at: '2026-06-25T00:00:00.000Z',
      deposit_paid_at: '2026-07-01T00:00:00.000Z',
      approval_snapshot: { amendments: [amendment] },
    });
    sbRef.current = client;
    const res = await POST(req({ amendedAt: '2026-07-17T00:00:00.000Z', signature }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('stale-amendment');
    expect(updatePayloads).toHaveLength(0);
  });

  it('fails a compare-and-swap race without overwriting consent', async () => {
    const { client } = makeSb(
      {
        id: ID,
        status: 'booked',
        quote_sent_at: '2026-06-20T00:00:00.000Z',
        customer_approved_at: '2026-06-25T00:00:00.000Z',
        deposit_paid_at: '2026-07-01T00:00:00.000Z',
        approval_snapshot: { amendments: [amendment] },
      },
      [],
    );
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT, signature }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('concurrent-amendment');
  });
});
