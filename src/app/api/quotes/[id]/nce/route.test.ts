// Tests for POST /api/quotes/[id]/nce (staff "Mark as NCE" toggle, admin
// quote detail page) — mirrors legacy-rebook/route.test.ts's structure.
//
// Verifies:
//   1. Operator gate is enforced (denied → gate response, no write).
//   2. Bad UUID id → 400 (no write).
//   3. Strict body validation: missing / non-boolean isNce → 400, and
//      malformed JSON → 400.
//   4. Happy path sets true.
//   5. Happy path sets false.
//   6. Unknown quote id → 404 (update matches 0 rows).
//   7. Tag propagation (#198): turning ON on an already-sent, customer-linked
//      quote propagates immediately; never on OFF (forward-only); never
//      before sent / without a linked customer; best-effort on failure.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperatorMock, sbRef, propagateMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  sbRef: { current: null as unknown },
  propagateMock: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/customers', () => ({
  propagateQuoteTagsToCustomer: propagateMock,
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
function makeSb(
  row: { id: string; is_nce: boolean; quote_sent_at?: string | null; customer_id?: string | null } | null,
) {
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
      return {
        data: {
          id: merged.id,
          is_nce: merged.is_nce,
          quote_sent_at: merged.quote_sent_at,
          customer_id: merged.customer_id,
        },
        error: null,
      };
    },
  });
  return { client: builder, updatePayloads };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
});

describe('POST /api/quotes/[id]/nce — operator gate', () => {
  it('returns the gate response and never writes when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/nce — validation', () => {
  it('400s on a non-UUID id', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false });
    sbRef.current = client;
    const res = await POST(makeReq({ isNce: true }), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s on malformed JSON body', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false });
    sbRef.current = client;
    const res = await POST(makeReq(undefined), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('400s when isNce is missing', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false });
    sbRef.current = client;
    const res = await POST(makeReq({}), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePayloads).toHaveLength(0);
  });

  it.each([['true'], [1], [null], [{}], [[]]])(
    '400s when isNce is a non-boolean value (%p)',
    async (value) => {
      const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false });
      sbRef.current = client;
      const res = await POST(makeReq({ isNce: value }), makeParams(VALID_UUID));
      expect(res.status).toBe(400);
      expect(updatePayloads).toHaveLength(0);
    },
  );
});

describe('POST /api/quotes/[id]/nce — happy path', () => {
  it('sets is_nce to true', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: false });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: true });
    expect(updatePayloads[0]).toEqual({ is_nce: true });
  });

  it('sets is_nce to false', async () => {
    const { client, updatePayloads } = makeSb({ id: VALID_UUID, is_nce: true });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: false });
    expect(updatePayloads[0]).toEqual({ is_nce: false });
  });
});

describe('POST /api/quotes/[id]/nce — unknown id', () => {
  it('404s when the update matches no row', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });
});

describe('POST /api/quotes/[id]/nce — tag propagation (#198)', () => {
  it('propagates NCE to the linked customer when turning ON on an already-sent quote', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledWith('cust-1', { isNce: true });
  });

  it('does NOT propagate when the quote has not been sent yet', async () => {
    const { client } = makeSb({ id: VALID_UUID, is_nce: false, quote_sent_at: null, customer_id: 'cust-1' });
    sbRef.current = client;

    await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT propagate when the quote has no linked customer', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: null,
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT propagate when turning the flag OFF, even on an already-sent, linked quote (forward-only)', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('still succeeds when propagation throws (best-effort)', async () => {
    propagateMock.mockRejectedValueOnce(new Error('customers table missing'));
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: true });
  });
});
