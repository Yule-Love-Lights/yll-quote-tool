// Tests for POST /api/customers/[customerId]/tenure-years (staff manual
// tenure-years editor). Mirrors src/app/api/quotes/[id]/view-only/route.test.ts.
//
// Verifies:
//   1. Operator gate is enforced (denied → gate response, no write).
//   2. Bad UUID id → 400 (no write).
//   3. Strict body validation: non-array / non-integer / out-of-range years,
//      and malformed JSON → 400.
//   4. Happy path: sorts + dedupes + saves.
//   5. Unknown customer id → 404 (update matches 0 rows).

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
// `row` is the row present in the table (null = no match, mirroring an
// unknown customer id).
function makeSb(row: { id: string; manual_years: number[] } | null) {
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
      const merged = { ...row, ...updatePayloads[updatePayloads.length - 1] };
      return { data: { id: merged.id, manual_years: merged.manual_years }, error: null };
    },
  });
  return { client: builder, updatePayloads };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
});

describe('POST /api/customers/[customerId]/tenure-years — operator gate', () => {
  it('returns the gate response and never writes when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;

    const res = await POST(makeReq({ manualYears: [2022] }), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/customers/[customerId]/tenure-years — validation', () => {
  it('400s on a non-UUID id', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const res = await POST(makeReq({ manualYears: [2022] }), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s on malformed JSON body', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const res = await POST(makeReq(undefined), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when manualYears is missing', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const res = await POST(makeReq({}), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePayloads).toHaveLength(0);
  });

  it.each([['2022'], [null], [{}], ['nope']])(
    '400s when manualYears is a non-array value (%p)',
    async (value) => {
      const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
      sbRef.current = client;
      const res = await POST(makeReq({ manualYears: value }), makeParams(VALID_UUID));
      expect(res.status).toBe(400);
      expect(updatePayloads).toHaveLength(0);
    },
  );

  it('400s when manualYears has more than 50 entries', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const tooMany = Array.from({ length: 51 }, (_, i) => 2015 + (i % 11));
    const res = await POST(makeReq({ manualYears: tooMany }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when an element is not an integer (string)', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const res = await POST(makeReq({ manualYears: [2022, '2023'] }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when an element is a non-integer float', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const res = await POST(makeReq({ manualYears: [2022.5] }), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when an element is below the plausible floor', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const res = await POST(makeReq({ manualYears: [2014] }), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when an element is a future year', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;
    const farFuture = new Date().getUTCFullYear() + 1;
    const res = await POST(makeReq({ manualYears: [farFuture] }), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/customers/[customerId]/tenure-years — happy path', () => {
  it('sorts and dedupes before saving', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [] });
    sbRef.current = client;

    const res = await POST(makeReq({ manualYears: [2022, 2020, 2022] }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, manualYears: [2020, 2022] });
    expect(updatePayloads[0]).toEqual({ manual_years: [2020, 2022] });
  });

  it('saves an empty array (removing all manual years)', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, manual_years: [2020] });
    sbRef.current = client;

    const res = await POST(makeReq({ manualYears: [] }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, manualYears: [] });
    expect(updatePayloads[0]).toEqual({ manual_years: [] });
  });
});

describe('POST /api/customers/[customerId]/tenure-years — unknown id', () => {
  it('404s when the update matches no row', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ manualYears: [2022] }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });
});
