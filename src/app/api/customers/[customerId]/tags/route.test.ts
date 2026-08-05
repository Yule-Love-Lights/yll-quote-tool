// Tests for POST /api/customers/[customerId]/tags (staff NCE + YLL Neighbor
// customer-profile add/remove chips, #198). Mirrors
// src/app/api/customers/[customerId]/tenure-years/route.test.ts's structure.
//
// Verifies:
//   1. Operator gate is enforced (denied → gate response, no write).
//   2. Bad UUID id → 400 (no write).
//   3. Strict body validation: non-boolean isNce/isYllNeighbor, neither
//      provided, and malformed JSON → 400.
//   4. Happy path: partial update (only the provided key(s) written).
//   5. Unknown customer id → 404 (update matches 0 rows).
//   6. Can explicitly turn a tag OFF (unlike quote-tag propagation, which is
//      forward-only) — this route is the one legitimate un-tag path.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperatorMock, sbRef } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST } from './route';

const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

function makeReq(body?: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as unknown as NextRequest;
}

function makeParams(customerId: string) {
  return { params: Promise.resolve({ customerId }) };
}

// Chainable mock covering the single call the route makes:
//   .update(payload).eq('id', id).select(...).maybeSingle()
// `row` is the row present in the table BEFORE the update (null = no match,
// mirroring an unknown customer id — the update then matches 0 rows).
function makeSb(row: { id: string; is_nce: boolean; is_yll_neighbor: boolean } | null) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    update: (payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    select: () => builder,
    maybeSingle: async () => {
      if (!row) return { data: null, error: null };
      const merged = { ...row, ...(updatePayloads[0] ?? {}) };
      return { data: { id: merged.id, is_nce: merged.is_nce, is_yll_neighbor: merged.is_yll_neighbor }, error: null };
    },
  });
  return { client: builder, updatePayloads };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
});

describe('POST /api/customers/[customerId]/tags — operator gate', () => {
  it('returns the gate response and never writes when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: false });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/customers/[customerId]/tags — validation', () => {
  it('400s on a non-UUID id', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: false });
    sbRef.current = client;
    const res = await POST(makeReq({ isNce: true }), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s on malformed JSON body', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: false });
    sbRef.current = client;
    const res = await POST(makeReq(undefined), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when neither isNce nor isYllNeighbor is provided', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: false });
    sbRef.current = client;
    const res = await POST(makeReq({}), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePayloads).toHaveLength(0);
  });

  it.each([['true'], [1], [{}], [[]]])(
    '400s when isNce is a non-boolean value (%p)',
    async (value) => {
      const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: false });
      sbRef.current = client;
      const res = await POST(makeReq({ isNce: value }), makeParams(VALID_UUID));
      expect(res.status).toBe(400);
      expect(updatePayloads).toHaveLength(0);
    },
  );

  it.each([['true'], [1], [{}], [[]]])(
    '400s when isYllNeighbor is a non-boolean value (%p)',
    async (value) => {
      const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: false });
      sbRef.current = client;
      const res = await POST(makeReq({ isYllNeighbor: value }), makeParams(VALID_UUID));
      expect(res.status).toBe(400);
      expect(updatePayloads).toHaveLength(0);
    },
  );
});

describe('POST /api/customers/[customerId]/tags — happy path', () => {
  it('sets isNce true, leaving isYllNeighbor untouched (partial update)', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: true });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: true, isYllNeighbor: true });
    expect(updatePayloads[0]).toEqual({ is_nce: true });
  });

  it('sets isYllNeighbor true, leaving isNce untouched (partial update)', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: true, is_yll_neighbor: false });
    sbRef.current = client;

    const res = await POST(makeReq({ isYllNeighbor: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: true, isYllNeighbor: true });
    expect(updatePayloads[0]).toEqual({ is_yll_neighbor: true });
  });

  it('sets both tags in one call when both are provided', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false, is_yll_neighbor: false });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true, isYllNeighbor: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: true, isYllNeighbor: true });
    expect(updatePayloads[0]).toEqual({ is_nce: true, is_yll_neighbor: true });
  });

  // Unlike quote-tag propagation (forward-only, never clears), this route IS
  // the legitimate staff "remove" path — explicit false is honored.
  it('explicitly turns a tag OFF (the staff remove control)', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: true, is_yll_neighbor: true });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: false, isYllNeighbor: true });
    expect(updatePayloads[0]).toEqual({ is_nce: false });
  });
});

describe('POST /api/customers/[customerId]/tags — unknown id', () => {
  it('404s when the update matches no row', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });
});
