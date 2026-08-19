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

const decreaseAmendment: AmendmentTrailEntry = {
  amended_at: AMENDED_AT,
  by: 'staff:ops',
  reason: 'Removed a spotlight',
  previous_total: 2400,
  new_total: 2000,
  previous_balance: 1400,
  new_balance: 1000,
  deposit_applied: 1000,
  delta: -400,
  line_item_changes: [],
  consent: { status: 'pending' },
};

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

function req(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return {
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const bookedQuote = (snapshot: Record<string, unknown>) => ({
  id: ID,
  status: 'booked',
  quote_sent_at: '2026-06-20T00:00:00.000Z',
  customer_approved_at: '2026-06-25T00:00:00.000Z',
  deposit_paid_at: '2026-07-01T00:00:00.000Z',
  approval_snapshot: snapshot,
});

const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => vi.clearAllMocks());

describe('POST /api/quotes/[id]/amend-decline', () => {
  it('rejects a malformed capability token before reading the quote', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), {
      params: Promise.resolve({ id: 'not-a-quote-id' }),
    });
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects a missing amendedAt before writing', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-decline');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects an oversized reason before writing', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT, reason: 'x'.repeat(501) }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-decline');
    expect(updatePayloads).toHaveLength(0);
  });

  it('atomically records a decline on the latest amendment, with no reason given', async () => {
    const originalSnapshot = { amendments: [amendment] };
    const { client, updatePayloads, eqCalls } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(eqCalls).toContainEqual(['approval_snapshot', JSON.stringify(originalSnapshot)]);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments[0].consent).toMatchObject({ status: 'declined' });
    expect(snapshot.amendments[0].consent).not.toHaveProperty('reason');
    expect((snapshot.amendments[0].consent as { declined_at: string }).declined_at).toBeTruthy();
  });

  it('records an optional customer-typed reason, distinct from the staff amendment reason', async () => {
    const originalSnapshot = { amendments: [amendment] };
    const { client, updatePayloads } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(
      req({ amendedAt: AMENDED_AT, reason: 'too expensive, please remove the wreath' }, {
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    const consent = snapshot.amendments[0].consent as { status: string; reason?: string; ip: string | null };
    expect(consent.status).toBe('declined');
    expect(consent.reason).toBe('too expensive, please remove the wreath');
    expect(consent.ip).toBe('203.0.113.7');
    // The STAFF-facing amendment reason is untouched — the two are separate fields.
    expect(snapshot.amendments[0].reason).toBe('Added front wreaths');
  });

  it('declining a price DECREASE still records it (both directions need a response)', async () => {
    const originalSnapshot = { amendments: [decreaseAmendment] };
    const { client, updatePayloads } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments[0].consent).toMatchObject({ status: 'declined' });
  });

  it('declines the pending price change while preserving a later cosmetic entry', async () => {
    const originalSnapshot = { amendments: [amendment, cosmeticAmendment] };
    const { client, updatePayloads, eqCalls } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(['approval_snapshot', JSON.stringify(originalSnapshot)]);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments).toHaveLength(2);
    expect(snapshot.amendments[0].consent?.status).toBe('declined');
    expect(snapshot.amendments[1]).toEqual(cosmeticAmendment);
  });

  // NOTE: a cosmetic (zero-delta) "latest" amendment can't reach the
  // consent-not-required branch through this route's own lookup —
  // latestConsentAmendment already filters to requiresReconsent entries, so a
  // cosmetic-only trail returns null and hits stale-amendment instead. The
  // requiresReconsent recheck in route.ts is defensive/belt-and-suspenders
  // (mirrors amend-consent/route.ts's identical, identically-unreachable
  // check — that route's own test suite doesn't exercise it either).
  it('a cosmetic-only trail has no consent-requiring amendment to decline', async () => {
    const noopAmendment: AmendmentTrailEntry = { ...cosmeticAmendment, amended_at: AMENDED_AT };
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [noopAmendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('stale-amendment');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects an outdated amendment id', async () => {
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [amendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: '2026-07-17T00:00:00.000Z' }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('stale-amendment');
    expect(updatePayloads).toHaveLength(0);
  });

  // Money-critical: declining an already-SIGNED amendment must never silently
  // discard the customer's real signature.
  it('refuses to decline an amendment the customer already accepted', async () => {
    const accepted: AmendmentTrailEntry = {
      ...amendment,
      consent: {
        status: 'accepted',
        accepted_at: '2026-07-18T13:00:00.000Z',
        signature: { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith', signed_at: '2026-07-18T13:00:00.000Z', ip: null },
      },
    };
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [accepted] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already-accepted');
    expect(updatePayloads).toHaveLength(0);
  });

  it('is idempotent: declining an already-declined amendment succeeds without a second write', async () => {
    const alreadyDeclined: AmendmentTrailEntry = {
      ...amendment,
      consent: { status: 'declined', declined_at: '2026-07-18T13:00:00.000Z', ip: null },
    };
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [alreadyDeclined] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.alreadyDeclined).toBe(true);
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects when the order is not a live booked order', async () => {
    const { client, updatePayloads } = makeSb({
      id: ID,
      status: 'cancelled',
      quote_sent_at: '2026-06-20T00:00:00.000Z',
      customer_approved_at: '2026-06-25T00:00:00.000Z',
      deposit_paid_at: null,
      approval_snapshot: { amendments: [amendment] },
    });
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not-booked');
    expect(updatePayloads).toHaveLength(0);
  });

  it('fails a compare-and-swap race without overwriting consent', async () => {
    const { client } = makeSb(bookedQuote({ amendments: [amendment] }), []);
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('concurrent-amendment');
  });

  it('confirms a declined price increase still blocks settlement in its own response', async () => {
    const { client } = makeSb(bookedQuote({ amendments: [amendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.stillBlocksSettlement).toBe(true);
  });

  it('confirms a declined price decrease does NOT block settlement in its own response', async () => {
    const { client } = makeSb(bookedQuote({ amendments: [decreaseAmendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.stillBlocksSettlement).toBe(false);
  });
});
