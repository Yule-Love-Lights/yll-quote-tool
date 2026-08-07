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

// #214: importOriginal keeps quoteRowToIdentity (pure sentinel translation)
// REAL — only the DB-touching fns are mocked.
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

// Chainable mock for .update(payload).eq('id', id).select(...).maybeSingle(),
// PLUS a second bare .update({inputs}).eq('id', id) (#199's deposit-default
// write — no .select() chained, so it resolves via `await` on the builder
// itself, same idiom as findOrCreateCustomer's fire-and-forget updates:
// `error` reads `undefined` off the builder object = no error). `row` is the
// row present in the table BEFORE the update (null = no match, mirroring an
// unknown quote id — the update then matches 0 rows). `opts.secondUpdateError`
// injects an error on the SECOND update call only (updatePayloads.length===2
// at the moment its .eq() resolves), for the #199 best-effort test.
function makeSb(
  row: {
    id: string;
    is_nce: boolean;
    quote_sent_at?: string | null;
    customer_id?: string | null;
    is_test?: boolean;
    deposit_paid_at?: string | null;
    customer_approved_at?: string | null;
    inputs?: Record<string, unknown> | null;
  } | null,
  opts: { secondUpdateError?: { message: string } } = {},
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    update: (payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => {
      if (opts.secondUpdateError && updatePayloads.length === 2) {
        return Promise.resolve({ error: opts.secondUpdateError });
      }
      return builder;
    },
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
          is_test: merged.is_test ?? false,
          // #214 round 3: the booked-freeze gate reads this off the same
          // select (null = unbooked, mirroring the real nullable column).
          deposit_paid_at: merged.deposit_paid_at ?? null,
          customer_approved_at: merged.customer_approved_at ?? null,
          inputs: merged.inputs ?? null,
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

  it('does NOT propagate when unlinked AND re-resolution yields nothing (identity-less quote)', async () => {
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

  // #214 (review-refined): the toggle trusts the CACHED customer_id when one
  // exists — updateQuote's own re-attach maintains it at every identity
  // edit, and an unconditional re-resolution here would newest-win an OLD
  // quote's stale stored fields onto a customer row later quotes kept
  // current (retroactive tagging of old quotes is a real workflow).
  it('does NOT re-resolve when a cached customer_id exists — propagates straight to it', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).toHaveBeenCalledWith('cust-1', { isNce: true });
  });

  // #214 round 3 (booked-freeze parity): the null-link heal never runs on a
  // booked quote — the customers link is frozen once money moved.
  it('does NOT attempt the null-link heal on a BOOKED quote (deposit paid)', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: null,
      deposit_paid_at: '2026-08-02T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  // #214: the old customer_id-non-null gate is lifted — tagging a sent,
  // never-linked quote now heals the link instead of silently skipping.
  it('heals a NEVER-linked sent quote when re-resolution finds the customer, then propagates', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'cust-healed', propertyId: 'p1' });
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledWith('cust-healed', { isNce: true });
  });

  it('does NOT even attempt re-resolution when turning OFF or on an un-sent quote (no extra round trips)', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
    });
    sbRef.current = client;
    await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();

    const { client: unsent } = makeSb({ id: VALID_UUID, is_nce: false, quote_sent_at: null, customer_id: 'cust-1' });
    sbRef.current = unsent;
    await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
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

  // Review fix (admin MED, S34 #198 review): defense-in-depth — this route
  // is admin-only (no realistic staff reason to toggle a test quote's NCE
  // flag), but the guard is cheap and keeps the "test quotes never touch
  // customers" invariant self-contained here too.
  it('does NOT propagate for a TAGGED TEST quote, even already-sent + linked', async () => {
    const { client } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      quote_sent_at: '2026-08-01T00:00:00Z',
      customer_id: 'cust-1',
      is_test: true,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
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

describe('POST /api/quotes/[id]/nce — NCE 40% deposit default (#199)', () => {
  it('writes depositPercent=40 when turning ON on a pre-approval quote with no existing override', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      customer_approved_at: null,
      inputs: { a: 1 },
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(updatePayloads[1]).toEqual({ inputs: { a: 1, depositPercent: 40 } });
  });

  it('writes depositPercent=40 when the stored depositPercent is explicitly 0', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      customer_approved_at: null,
      inputs: { depositPercent: 0 },
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(updatePayloads[1]).toEqual({ inputs: { depositPercent: 40 } });
  });

  it('does NOT overwrite an explicit staff-set depositPercent when turning ON', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      customer_approved_at: null,
      inputs: { depositPercent: 25 },
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    // Only the tag update ran — no second (deposit) write.
    expect(updatePayloads).toHaveLength(1);
  });

  it('removes an untouched 40 when turning OFF pre-approval', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      customer_approved_at: null,
      inputs: { depositPercent: 40, a: 1 },
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    expect(updatePayloads[1]).toEqual({ inputs: { a: 1 } });
  });

  it('leaves a non-40 depositPercent alone when turning OFF', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      customer_approved_at: null,
      inputs: { depositPercent: 25 },
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    expect(updatePayloads).toHaveLength(1);
  });

  it('never touches the deposit percent once the quote is customer-approved (#177 freeze) — turning ON', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      customer_approved_at: '2026-08-01T00:00:00Z',
      inputs: {},
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(updatePayloads).toHaveLength(1);
  });

  it('never touches the deposit percent once the quote is customer-approved (#177 freeze) — turning OFF', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      customer_approved_at: '2026-08-01T00:00:00Z',
      inputs: { depositPercent: 40 },
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    expect(updatePayloads).toHaveLength(1);
  });

  it('is best-effort — a deposit-write failure never fails the toggle', async () => {
    const { client } = makeSb(
      {
        id: VALID_UUID,
        is_nce: false,
        customer_approved_at: null,
        inputs: {},
      },
      { secondUpdateError: { message: 'db down' } },
    );
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: true });
  });
});
