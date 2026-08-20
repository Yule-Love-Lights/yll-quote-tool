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
// PLUS a second CAS'd .update({inputs}).eq('id',id).is('customer_approved_at',
// null).is/eq('inputs',...).select('id') (#199 F3's deposit-default write —
// terminal .select('id') resolves explicitly so tests can simulate a CAS HIT
// (default: 1 row) or a lost race / DB error via `opts.depositWriteResult`.
// `row` is the row present in the table BEFORE the update (null = no match,
// mirroring an unknown quote id — the update then matches 0 rows).
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
    // #243: undefined (every pre-existing test's default) resolves holiday-
    // eligible, matching canCarryNceOrYllNeighborTag's null/undefined case —
    // so no pre-existing test needed updating for the new gate.
    service_type?: string | null;
  } | null,
  opts: {
    depositWriteResult?: { data: Array<{ id: string }> | null; error: { message: string } | null };
    // Fix-round LOW (TOCTOU) test hook: simulate the #243 ON-gate's CAS
    // losing a race — service_type changed between the gate read and the
    // main is_nce write, so that write's own .eq/.is('service_type', ...)
    // matches 0 rows. Only takes effect on the MAIN update's maybeSingle
    // call (see the updatePayloads.length check below) — never the gate
    // read itself (or the gate could never approve turning ON to begin
    // with) and never the deposit-write CAS (a separate, already-tested
    // mechanism via depositWriteResult above).
    simulateServiceTypeRace?: boolean;
  } = {},
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  // Tracks every .eq/.is filter call, tagged with which update (by index
  // into updatePayloads at call time) it applied to — lets a test assert
  // the CAS actually filtered on 'service_type', not just that SOME filter
  // ran (0 = calls before any update, e.g. the gate read's .eq('id', id)).
  const filterCalls: Array<{ method: 'eq' | 'is'; col: string; val: unknown; updateIndex: number }> = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    update: (payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filterCalls.push({ method: 'eq', col, val, updateIndex: updatePayloads.length });
      return builder;
    },
    is: (col: string, val: unknown) => {
      filterCalls.push({ method: 'is', col, val, updateIndex: updatePayloads.length });
      return builder;
    },
    select: (cols?: string) => {
      // The SECOND (deposit-default) update's terminal .select('id') — the
      // FIRST update's own .select(<long column list>) never passes 'id' alone.
      if (cols === 'id' && updatePayloads.length === 2) {
        return Promise.resolve(
          opts.depositWriteResult ?? { data: [{ id: row?.id ?? '' }], error: null },
        );
      }
      return builder;
    },
    maybeSingle: async () => {
      if (!row) return { data: null, error: null };
      // updatePayloads.length === 1 identifies THIS call as the main
      // update's own maybeSingle (the gate read's maybeSingle runs with
      // ZERO update payloads pushed yet).
      if (
        opts.simulateServiceTypeRace &&
        updatePayloads.length === 1 &&
        updatePayloads[0]?.is_nce === true
      ) {
        return { data: null, error: null };
      }
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
          // #243: the service-type gate's pre-write read reuses this same
          // chainable mock (select → maybeSingle, called BEFORE any update
          // payload exists) — see its own describe block below.
          service_type: merged.service_type ?? null,
        },
        error: null,
      };
    },
  });
  return { client: builder, updatePayloads, filterCalls };
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

describe('POST /api/quotes/[id]/nce — service-type gate (#243)', () => {
  it.each([['permanent'], ['event'], ['permanent_bistro']])(
    'rejects turning ON for a %s quote with 400/not-holiday, no write',
    async (serviceType) => {
      const { client, updatePayloads } = makeSb({
        id: VALID_UUID,
        is_nce: false,
        service_type: serviceType,
      });
      sbRef.current = client;

      const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe('not-holiday');
      expect(updatePayloads).toHaveLength(0);
    },
  );

  it.each([['holiday'], [null], [undefined]])(
    'allows turning ON for a holiday (or un-categorized) quote — service_type %p',
    async (serviceType) => {
      const { client, updatePayloads } = makeSb({
        id: VALID_UUID,
        is_nce: false,
        service_type: serviceType as string | null | undefined,
      });
      sbRef.current = client;

      const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
      expect(res.status).toBe(200);
      expect(updatePayloads[0]).toEqual({ is_nce: true });
    },
  );

  it('404s (not 400) when turning ON a non-existent quote — the gate read runs before the not-found check', async () => {
    const { client, updatePayloads } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
    expect(updatePayloads).toHaveLength(0);
  });

  // Turning OFF must always be allowed, even on a permanent quote — this is
  // the correction path for an existing violating row (from before this gate
  // shipped); the gate only ever blocks the ON direction.
  it('allows turning OFF on a permanent quote (untagging an existing violation is never blocked)', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      service_type: 'permanent',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: false });
    expect(updatePayloads[0]).toEqual({ is_nce: false });
  });
});

// Fix-round LOW (TOCTOU): the #243 ON-gate above reads service_type, then
// the write previously landed unconditionally — a concurrent service-type
// change between the read and the write could land is_nce:true on a
// now-ineligible quote. The write now CASes against the exact value the gate
// just approved.
describe('POST /api/quotes/[id]/nce — service-type write CAS (fix-round LOW, TOCTOU)', () => {
  it('CASes the ON write against service_type — .eq for a concrete value', async () => {
    const { client, filterCalls } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      service_type: 'holiday',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    // updateIndex === 1 = filters applied to the MAIN (is_nce) update, not
    // the gate read (updateIndex 0) or a later deposit-default write.
    expect(filterCalls).toContainEqual({
      method: 'eq',
      col: 'service_type',
      val: 'holiday',
      updateIndex: 1,
    });
  });

  it('CASes the ON write against service_type — .is for the null case (mirrors canCarryNceOrYllNeighborTag\'s null-is-eligible rule)', async () => {
    const { client, filterCalls } = makeSb({
      id: VALID_UUID,
      is_nce: false,
      service_type: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(filterCalls).toContainEqual({
      method: 'is',
      col: 'service_type',
      val: null,
      updateIndex: 1,
    });
  });

  it('does NOT CAS the OFF write on service_type — turning OFF stays unconditional', async () => {
    const { client, filterCalls } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      service_type: 'permanent',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(filterCalls.some((c) => c.col === 'service_type' && c.updateIndex === 1)).toBe(false);
  });

  it('409s with code gate-race when service_type changes between the gate read and the write', async () => {
    const { client, updatePayloads } = makeSb(
      { id: VALID_UUID, is_nce: false, service_type: 'holiday' },
      { simulateServiceTypeRace: true },
    );
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('gate-race');
    // The write was attempted once (the CAS'd main update) and never reached
    // the #199 deposit-default write — data was null, so that section never runs.
    expect(updatePayloads).toHaveLength(1);
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

  // #226 (adversarial-review HIGH, live-prod bug fix): this used to DELETE
  // the depositPercent key instead of writing 0. A deleted key reads back as
  // `undefined`, which chargesFromResult treats as "no live value to offer"
  // and falls through to a possibly-stale result.depositRate (still 0.4 if
  // Calculate last ran while NCE was ON) — see derivePackages.test.ts's own
  // #226 trap test. An explicit 0 resolves correctly via effectiveDepositRate.
  it('resets an untouched 40 to an explicit depositPercent=0 (not a dropped key) when turning OFF pre-approval (#226)', async () => {
    const { client, updatePayloads } = makeSb({
      id: VALID_UUID,
      is_nce: true,
      customer_approved_at: null,
      inputs: { depositPercent: 40, a: 1 },
    });
    sbRef.current = client;

    await POST(makeReq({ isNce: false }), makeParams(VALID_UUID));
    expect(updatePayloads[1]).toEqual({ inputs: { a: 1, depositPercent: 0 } });
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

  it('is best-effort — a deposit-write DB error never fails the toggle', async () => {
    const { client } = makeSb(
      {
        id: VALID_UUID,
        is_nce: false,
        customer_approved_at: null,
        inputs: {},
      },
      { depositWriteResult: { data: null, error: { message: 'db down' } } },
    );
    sbRef.current = client;

    const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, isNce: true });
  });

  // #199 F3 (wrap-review MED-HIGH): the deposit write is a read-modify-write
  // of the WHOLE inputs jsonb — CAS'd against the exact inputs read above (+
  // customer_approved_at re-checked still null), mirroring free-items/route.ts's
  // approval_snapshot CAS. A lost race (a concurrent builder Calculate/save,
  // or a concurrent approve) must skip the write, not silently clobber the
  // newer state — and never fail the tag toggle itself (best-effort).
  describe('deposit-write CAS (#199 F3)', () => {
    it('is best-effort — a lost CAS race (concurrent inputs change) never fails the toggle', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { client, updatePayloads } = makeSb(
        { id: VALID_UUID, is_nce: false, customer_approved_at: null, inputs: {} },
        { depositWriteResult: { data: [], error: null } }, // 0 rows — CAS missed
      );
      sbRef.current = client;

      const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ ok: true, isNce: true });
      // The write was ATTEMPTED (the payload was sent)...
      expect(updatePayloads[1]).toEqual({ inputs: { depositPercent: 40 } });
      // ...but the route knows it didn't land — surfaced as a warning, not
      // silently swallowed and not surfaced as a client-facing failure.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('changed concurrently'));
      warnSpy.mockRestore();
    });

    it('does not warn on a normal CAS hit (the default happy path)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { client } = makeSb({
        id: VALID_UUID,
        is_nce: false,
        customer_approved_at: null,
        inputs: {},
      });
      sbRef.current = client;

      const res = await POST(makeReq({ isNce: true }), makeParams(VALID_UUID));
      expect(res.status).toBe(200);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
