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
    // #243: undefined (every existing test's default) resolves holiday-
    // eligible, matching canCarryNceOrYllNeighborTag's null/undefined case —
    // so no pre-existing test needed updating for the new gate.
    service_type?: string | null;
  } | null,
  opts: {
    // Fix-round LOW (TOCTOU) test hook: simulate the #243 ON-gate's CAS
    // losing a race — service_type changed between the gate read and the
    // main legacy_rebook write, so that write's own .eq/.is('service_type',
    // ...) matches 0 rows. Only takes effect on the MAIN update's
    // maybeSingle call (updatePayloads.length === 1), mirroring the sibling
    // /nce route test's own hook.
    simulateServiceTypeRace?: boolean;
  } = {},
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  // Tracks every .eq/.is filter call, tagged with which update (by index
  // into updatePayloads at call time) it applied to.
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
    select: () => builder,
    maybeSingle: async () => {
      if (!row) return { data: null, error: null };
      // updatePayloads.length === 1 identifies THIS call as the main
      // update's own maybeSingle (the gate read's maybeSingle runs with
      // ZERO update payloads pushed yet).
      if (
        opts.simulateServiceTypeRace &&
        updatePayloads.length === 1 &&
        updatePayloads[0]?.legacy_rebook === true
      ) {
        return { data: null, error: null };
      }
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
          // #243: the service-type gate's pre-write read reuses this same
          // chainable mock (select → maybeSingle, called BEFORE the update
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

describe('POST /api/quotes/[id]/legacy-rebook — service-type gate (#243)', () => {
  it.each([['permanent'], ['event'], ['permanent_bistro']])(
    'rejects turning ON for a %s quote with 400/not-holiday, no write',
    async (serviceType) => {
      const { client, updatePayloads } = makeSb({
        id: VALID_UUID,
        legacy_rebook: false,
        service_type: serviceType,
      });
      sbRef.current = client;

      const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
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
        legacy_rebook: false,
        service_type: serviceType as string | null | undefined,
      });
      sbRef.current = client;

      const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
      expect(res.status).toBe(200);
      expect(updatePayloads[0]).toEqual({ legacy_rebook: true });
    },
  );

  it('404s (not 400) when turning ON a non-existent quote — the gate read runs before the not-found check', async () => {
    const { client, updatePayloads } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
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
      legacy_rebook: true,
      service_type: 'permanent',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: false }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, legacyRebook: false });
    expect(updatePayloads[0]).toEqual({ legacy_rebook: false });
  });
});

// Fix-round LOW (TOCTOU), sibling-guard parity with the /nce route's own
// fix: the #243 ON-gate above reads service_type, then the write previously
// landed unconditionally — a concurrent service-type change between the
// read and the write could land legacy_rebook:true on a now-ineligible
// quote. The write now CASes against the exact value the gate just approved.
describe('POST /api/quotes/[id]/legacy-rebook — service-type write CAS (fix-round LOW, TOCTOU)', () => {
  it('CASes the ON write against service_type — .eq for a concrete value', async () => {
    const { client, filterCalls } = makeSb({
      id: VALID_UUID,
      legacy_rebook: false,
      service_type: 'holiday',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    // updateIndex === 1 = filters applied to the MAIN (legacy_rebook)
    // update, not the gate read (updateIndex 0).
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
      legacy_rebook: false,
      service_type: null,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
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
      legacy_rebook: true,
      service_type: 'permanent',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: false }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(filterCalls.some((c) => c.col === 'service_type' && c.updateIndex === 1)).toBe(false);
  });

  it('409s with code gate-race when service_type changes between the gate read and the write', async () => {
    const { client, updatePayloads } = makeSb(
      { id: VALID_UUID, legacy_rebook: false, service_type: 'holiday' },
      { simulateServiceTypeRace: true },
    );
    sbRef.current = client;

    const res = await POST(makeReq({ legacyRebook: true }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('gate-race');
    expect(updatePayloads).toHaveLength(1);
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
