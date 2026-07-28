// Tests for POST /api/quotes/[id]/view-only (staff "Mark as view-only"
// toggle, admin quote detail page). Mirrors legacy-rebook/route.test.ts.
//
// Verifies:
//   1. Operator gate is enforced (denied → gate response, no write).
//   2. Bad UUID id → 400 (no write).
//   3. Strict body validation: missing / non-boolean viewOnly → 400, and
//      malformed JSON → 400.
//   4. Happy path sets true.
//   5. Happy path sets false.
//   6. Unknown quote id → 404 (update matches 0 rows).

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

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// Chainable mock covering BOTH calls the route can make:
//   1. (only when turning ON) a plain pre-check read:
//      .select('id, status, customer_approved_at, deposit_paid_at').eq().maybeSingle()
//   2. the update: .update(payload).eq('id', id).select(...).maybeSingle()
// `row` is the row present in the table (null = no match, mirroring an
// unknown quote id — both the pre-check and the update then match 0 rows).
// `pendingUpdate` tracks whether an .update() has fired yet so maybeSingle()
// can tell the pre-check read apart from the post-update select.
function makeSb(
  row: {
    id: string;
    view_only: boolean;
    status?: string | null;
    customer_approved_at?: string | null;
    deposit_paid_at?: string | null;
  } | null,
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  let pendingUpdate = false;
  Object.assign(builder, {
    from: () => builder,
    update: (payload: Record<string, unknown>) => {
      pendingUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    select: () => builder,
    maybeSingle: async () => {
      if (!row) return { data: null, error: null };
      if (pendingUpdate) {
        pendingUpdate = false;
        const merged = { ...row, ...updatePayloads[updatePayloads.length - 1] };
        return { data: { id: merged.id, view_only: merged.view_only }, error: null };
      }
      // The pre-check read — returns the full row (status + timestamps).
      return { data: row, error: null };
    },
  });
  return { client: builder, updatePayloads };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
});

describe('POST /api/quotes/[id]/view-only — operator gate', () => {
  it('returns the gate response and never writes when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, view_only: false });
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/view-only — validation', () => {
  it('400s on a non-UUID id', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, view_only: false });
    sbRef.current = client;
    const res = await POST(makeReq({ viewOnly: true }), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s on malformed JSON body', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, view_only: false });
    sbRef.current = client;
    const res = await POST(makeReq(undefined), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when viewOnly is missing', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, view_only: false });
    sbRef.current = client;
    const res = await POST(makeReq({}), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePayloads).toHaveLength(0);
  });

  it.each([['true'], [1], [null], [{}], [[]]])(
    '400s when viewOnly is a non-boolean value (%p)',
    async (value) => {
      const { client, updatePayloads } = makeSb({ id: VALID_UUID, view_only: false });
      sbRef.current = client;
      const res = await POST(makeReq({ viewOnly: value }), makeParams(VALID_UUID));
      expect(res.status).toBe(400);
      expect(updatePayloads).toHaveLength(0);
    },
  );
});

describe('POST /api/quotes/[id]/view-only — happy path', () => {
  it('sets view_only to true', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, view_only: false });
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, viewOnly: true });
    expect(updatePayloads[0]).toEqual({ view_only: true });
  });

  it('sets view_only to false', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, view_only: true });
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: false }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, viewOnly: false });
    expect(updatePayloads[0]).toEqual({ view_only: false });
  });
});

// #176 fix-batch — turning view-only ON must not silently hide a booked
// (paid) order's real approve/pay UI behind the browsing strip. Turning OFF
// stays unconditional (it only restores normal behavior).
describe('POST /api/quotes/[id]/view-only — status-awareness (turning ON)', () => {
  it('409s (already-booked) when the deposit is already paid', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      view_only: false,
      status: 'approved',
      deposit_paid_at: '2026-07-01T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('already-booked');
    expect(updatePayloads).toHaveLength(0);
  });

  it('409s (already-booked) when status is booked, even with no deposit_paid_at (belt-and-suspenders)', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      view_only: false,
      status: 'booked',
      deposit_paid_at: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('already-booked');
    expect(updatePayloads).toHaveLength(0);
  });

  it('allows turning ON an approved-but-unpaid quote', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      view_only: false,
      status: 'approved',
      customer_approved_at: '2026-07-01T00:00:00Z',
      deposit_paid_at: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, viewOnly: true });
    expect(updatePayloads[0]).toEqual({ view_only: true });
  });

  it('always allows turning OFF, even on a booked quote', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      view_only: true,
      status: 'booked',
      deposit_paid_at: '2026-07-01T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: false }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, viewOnly: false });
    expect(updatePayloads[0]).toEqual({ view_only: false });
  });
});

describe('POST /api/quotes/[id]/view-only — unknown id', () => {
  it('404s when the update matches no row', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ viewOnly: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });
});
