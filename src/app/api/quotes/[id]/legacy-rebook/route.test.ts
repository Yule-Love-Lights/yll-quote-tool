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

const { requireOperatorMock, sbRef, attachQuoteToCustomerMock, propagateMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  sbRef: { current: null as unknown },
  // #214: the route now verify-or-reattaches before propagating.
  attachQuoteToCustomerMock: vi.fn(async () => null as null | { customerId: string; propertyId: string }),
  propagateMock: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

// #198: propagateQuoteTagsToCustomer mocked so the already-sent propagation
// branch is testable without a real customers table. #214: importOriginal
// keeps quoteRowToIdentity (pure sentinel translation) REAL — only the
// DB-touching fns are mocked.
vi.mock('@/lib/customers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customers')>()),
  attachQuoteToCustomer: attachQuoteToCustomerMock,
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
// quote_sent_at/customer_id (#198) default undefined (absent) when the test's
// row doesn't set them — same as every existing test here, so the tag-
// propagation branch stays a no-op unless a test opts in.
function makeSb(
  row: {
    id: string;
    legacy_rebook: boolean;
    quote_sent_at?: string | null;
    customer_id?: string | null;
    is_test?: boolean;
    deposit_paid_at?: string | null;
  } | null,
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
          legacy_rebook: merged.legacy_rebook,
          quote_sent_at: merged.quote_sent_at,
          customer_id: merged.customer_id,
          is_test: merged.is_test ?? false,
          // #214 round 3: the booked-freeze gate reads this off the same
          // select (null = unbooked, mirroring the real nullable column).
          deposit_paid_at: merged.deposit_paid_at ?? null,
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

describe('POST /api/quotes/[id]/legacy-rebook — tag propagation (#198)', () => {
  it('propagates YLL Neighbor to the linked customer when turning ON on an already-sent quote', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledWith('cust-1', { isYllNeighbor: true });
  });

  it('does NOT propagate when the quote has not been sent yet', async () => {
    const { client } = makeSb({ id: VALID_UUID, legacy_rebook: false, quote_sent_at: null, customer_id: 'cust-1' });
    sbRef.current = client;

    await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT propagate when unlinked AND re-resolution yields nothing (identity-less quote)', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: null,
    });
    sbRef.current = client;

    await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(propagateMock).not.toHaveBeenCalled();
  });

  // #214 (review-refined): cached-first — mirrors the sibling /nce route's
  // tests (sibling-guard parity; see its comment for the stale-old-quote
  // rationale).
  it('does NOT re-resolve when a cached customer_id exists — propagates straight to it', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).toHaveBeenCalledWith('cust-1', { isYllNeighbor: true });
  });

  it('heals a NEVER-linked sent quote when re-resolution finds the customer, then propagates', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'cust-healed', propertyId: 'p1' });
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledWith('cust-healed', { isYllNeighbor: true });
  });

  // #214 round 3 (booked-freeze parity) — mirrors the sibling /nce test.
  it('does NOT attempt the null-link heal on a BOOKED quote (deposit paid)', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: null,
      deposit_paid_at: '2026-08-02T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT propagate when turning the flag OFF, even on an already-sent, linked quote (forward-only)', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: true,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    await POST(makeReq({ legacyRebook: false }), makeParams(VALID_UUID));
    expect(propagateMock).not.toHaveBeenCalled();
  });

  // Review fix (admin MED, S34 #198 review): defense-in-depth — mirrors the
  // sibling /nce route's test.
  it('does NOT propagate for a TAGGED TEST quote, even already-sent + linked', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
      is_test: true,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('still succeeds when propagation throws (best-effort)', async () => {
    propagateMock.mockRejectedValueOnce(new Error('customers table missing'));
    const { client } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, legacyRebook: true });
  });
});
