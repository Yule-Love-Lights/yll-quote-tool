// Tests for POST /api/quotes/[id]/legacy-rebook (staff "Mark as YLL Neighbor"
// toggle, admin quote detail page).
//
// Verifies:
//   1. Operator gate is enforced (denied → gate response, no write).
//   2. Bad UUID id → 400 (no write).
//   3. Strict body validation: missing / non-boolean legacyRebook → 400, and
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

// Chainable mock for .update(payload).eq('id', id).select(...).maybeSingle().
// `row` is the row present in the table BEFORE the update (null = no match,
// mirroring an unknown quote id — the update then matches 0 rows).
function makeSb(row: { id: string; legacy_rebook: boolean } | null) {
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
      return { data: { id: merged.id, legacy_rebook: merged.legacy_rebook }, error: null };
    },
  });
  return { client: builder, updatePayloads };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
});

describe('POST /api/quotes/[id]/legacy-rebook — operator gate', () => {
  it('returns the gate response and never writes when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, legacy_rebook: false });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/legacy-rebook — validation', () => {
  it('400s on a non-UUID id', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, legacy_rebook: false });
    sbRef.current = client;
    const res = await POST(makeReq({ legacyRebook: true }), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s on malformed JSON body', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, legacy_rebook: false });
    sbRef.current = client;
    const res = await POST(makeReq(undefined), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when legacyRebook is missing', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, legacy_rebook: false });
    sbRef.current = client;
    const res = await POST(makeReq({}), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePayloads).toHaveLength(0);
  });

  it.each([['true'], [1], [null], [{}], [[]]])(
    '400s when legacyRebook is a non-boolean value (%p)',
    async (value) => {
      const { client, updatePayloads } = makeSb({ id: VALID_UUID, legacy_rebook: false });
      sbRef.current = client;
      const res = await POST(makeReq({ legacyRebook: value }), makeParams(VALID_UUID));
      expect(res.status).toBe(400);
      expect(updatePayloads).toHaveLength(0);
    },
  );
});

describe('POST /api/quotes/[id]/legacy-rebook — happy path', () => {
  it('sets legacy_rebook to true', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, legacy_rebook: false });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, legacyRebook: true });
    expect(updatePayloads[0]).toEqual({ legacy_rebook: true });
  });

  it('sets legacy_rebook to false', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, legacy_rebook: true });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: false }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, legacyRebook: false });
    expect(updatePayloads[0]).toEqual({ legacy_rebook: false });
  });
});

describe('POST /api/quotes/[id]/legacy-rebook — unknown id', () => {
  it('404s when the update matches no row', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });
});
