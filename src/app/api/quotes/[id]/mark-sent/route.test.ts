// Tests for POST /api/quotes/[id]/mark-sent (#182).
//
// Manual "Mark as sent" — staff delivered the quote outside the tool
// (hand-texted the portal link, walked through it on a call). DB-only:
// stamps quote_sent_at + status='sent', the SAME DB end-state a real send
// produces, with NO messaging and NO GHL calls of any kind.
//
//   - operator-only (requireOperator)
//   - legal only from a state canTransition(_, 'sent') allows (draft in
//     practice — changes_requested always has quote_sent_at already set)
//   - already sent (quote_sent_at set) → 409 already-sent, no write
//   - view-only → 409 view-only, no write
//   - illegal transition (approved/declined/booked/etc.) → 409 illegal-transition
//   - the write is GUARDED: .is('quote_sent_at', null).eq('view_only', false)
//     .or(markable) — a concurrent race (0 rows) → 409 invalid-status
//   - unknown id → 404

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperatorMock, sbRef, attachQuoteToCustomerMock, propagateMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  sbRef: { current: null as unknown },
  // #198: mocked so the existing DRAFT_QUOTE fixture (no tags set) never
  // reaches these, and the tag-propagation tests below can assert on them.
  attachQuoteToCustomerMock: vi.fn(async () => null as null | { customerId: string; propertyId: string }),
  propagateMock: vi.fn(async () => {}),
}));

// #214: importOriginal keeps quoteRowToIdentity (pure sentinel translation)
// REAL — only the DB-touching fns are mocked.
vi.mock('@/lib/customers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customers')>()),
  attachQuoteToCustomer: attachQuoteToCustomerMock,
  propagateQuoteTagsToCustomer: propagateMock,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

// Chainable Supabase mock.
//   maybeSingle() → the quote row (the initial read)
//   .update().eq().eq().is().or().select() terminates via .then() → updateRows
function makeSb(
  quote: Record<string, unknown> | null,
  updateRows: Array<{ id: string }> | null = [{ id: ID }],
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const orArgs: string[] = [];
  let pendingIsUpdate = false;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      pendingIsUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    is: () => builder,
    or: (f: string) => {
      orArgs.push(f);
      return builder;
    },
    maybeSingle: async () => ({ data: quote, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const isUpd = pendingIsUpdate;
      pendingIsUpdate = false;
      resolve(isUpd ? { data: updateRows, error: null } : { data: quote, error: null });
    },
  });
  return { client: builder, updatePayloads, orArgs };
}

const DRAFT_QUOTE = {
  id: ID,
  status: null,
  quote_sent_at: null,
  viewed_at: null,
  customer_approved_at: null,
  deposit_paid_at: null,
  view_only: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
});

describe('POST /api/quotes/[id]/mark-sent — operator gate', () => {
  it('returns the gate response and never writes when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const { client, updatePayloads } = makeSb(DRAFT_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(401);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/mark-sent — validation', () => {
  it('400s on a non-UUID id', async () => {
    const { client, updatePayloads } = makeSb(DRAFT_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq(), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/mark-sent — unknown id', () => {
  it('404s when the quote does not exist', async () => {
    const { client, updatePayloads } = makeSb(null);
    sbRef.current = client;
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/mark-sent — happy path', () => {
  it('stamps EXACTLY quote_sent_at + status=sent on a draft quote (the real send route DB end-state, minus messaging/GHL)', async () => {
    const { client, updatePayloads, orArgs } = makeSb(DRAFT_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('sent');
    expect(typeof json.sentAt).toBe('string');

    const payload = updatePayloads[0];
    expect(Object.keys(payload).sort()).toEqual(['quote_sent_at', 'status']);
    expect(payload.status).toBe('sent');
    expect(typeof payload.quote_sent_at).toBe('string');
    expect(payload.quote_sent_at).toBe(json.sentAt);

    // Guard: the write is filtered to still-markable rows.
    expect(orArgs[0]).toContain('status.in.(draft,changes_requested)');
    expect(orArgs[0]).toContain('status.is.null');
  });
});

describe('POST /api/quotes/[id]/mark-sent — already sent', () => {
  it('409s (already-sent) when quote_sent_at is already set, no write', async () => {
    const { client, updatePayloads } = makeSb({
      ...DRAFT_QUOTE,
      status: 'sent',
      quote_sent_at: '2026-07-01T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('already-sent');
    expect(updatePayloads).toHaveLength(0);
  });

  it('409s (already-sent) for a changes_requested quote (it always carries quote_sent_at)', async () => {
    const { client, updatePayloads } = makeSb({
      ...DRAFT_QUOTE,
      status: 'changes_requested',
      quote_sent_at: '2026-07-01T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('already-sent');
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/mark-sent — view-only', () => {
  it('409s when the quote is view-only, no write', async () => {
    const { client, updatePayloads } = makeSb({ ...DRAFT_QUOTE, view_only: true });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe('This quote is view-only');
    expect(json.code).toBe('view-only');
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/mark-sent — illegal transitions', () => {
  it.each([
    ['approved', { customer_approved_at: '2026-07-01T00:00:00Z' }],
    ['declined', { status: 'declined' as const }],
    ['cancelled', { status: 'cancelled' as const }],
    ['lost', { status: 'lost' as const }],
  ])('409s (illegal-transition) from %s — quote_sent_at is null but the transition is not legal', async (_label, extra) => {
    const { client, updatePayloads } = makeSb({ ...DRAFT_QUOTE, ...extra });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('illegal-transition');
    expect(updatePayloads).toHaveLength(0);
  });

  it('409s (illegal-transition) from a booked (deposit-paid) quote', async () => {
    const { client, updatePayloads } = makeSb({
      ...DRAFT_QUOTE,
      customer_approved_at: '2026-07-01T00:00:00Z',
      deposit_paid_at: '2026-07-02T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('illegal-transition');
    expect(updatePayloads).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/mark-sent — race loss on write', () => {
  it('handles a concurrent race (update returns 0 rows) as a 409 invalid-status', async () => {
    const { client } = makeSb(DRAFT_QUOTE, []); // [] = race loser
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invalid-status');
  });
});

describe('POST /api/quotes/[id]/mark-sent — NCE + YLL Neighbor tag propagation (#198)', () => {
  // #214: attach-first even when a cached customer_id exists (verify-or-
  // reattach — the cached link can be stale after an identity edit); the
  // cached id is only the fallback when re-resolution yields nothing.
  it('re-verifies via attachQuoteToCustomer even when ALREADY linked, falling back to the cached id when re-resolution yields nothing', async () => {
    const { client } = makeSb({ ...DRAFT_QUOTE, legacy_rebook: true, is_nce: true, customer_id: 'cust-1' });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).toHaveBeenCalledOnce();
    expect(propagateMock).toHaveBeenCalledWith('cust-1', { isNce: true, isYllNeighbor: true });
  });

  it('propagates to the RE-RESOLVED customer (not the cached id) when re-attach lands on a different row', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'cust-right', propertyId: 'prop-1' });
    const { client } = makeSb({ ...DRAFT_QUOTE, legacy_rebook: true, is_nce: true, customer_id: 'cust-stale' });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledWith('cust-right', { isNce: true, isYllNeighbor: true });
  });

  it('re-attaches via attachQuoteToCustomer when tagged but NOT yet linked, then propagates', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'cust-resolved', propertyId: 'prop-1' });
    const { client } = makeSb({
      ...DRAFT_QUOTE,
      legacy_rebook: false,
      is_nce: true,
      customer_id: null,
      customer_email: 'jane@x.com',
    });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, customer_email: 'jane@x.com' }),
    );
    expect(propagateMock).toHaveBeenCalledWith('cust-resolved', { isNce: true, isYllNeighbor: false });
  });

  it('does NOT attach or propagate when the quote carries neither tag (the DRAFT_QUOTE default)', async () => {
    const { client } = makeSb(DRAFT_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  // Review fix (admin HIGH, S34 #198 review): a tagged TEST quote must never
  // run attach/propagation with test data — see the sibling /send route test
  // for the full rationale.
  it('does NOT attach or propagate for a TAGGED TEST quote, even unlinked — mark-sent still succeeds', async () => {
    const { client } = makeSb({ ...DRAFT_QUOTE, is_test: true, legacy_rebook: true, is_nce: true, customer_id: null });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('does NOT attach or propagate for a TAGGED TEST quote that IS already linked', async () => {
    const { client } = makeSb({ ...DRAFT_QUOTE, is_test: true, legacy_rebook: true, is_nce: true, customer_id: 'cust-1' });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('still marks sent successfully when propagation throws (best-effort)', async () => {
    propagateMock.mockRejectedValueOnce(new Error('customers table missing'));
    const { client } = makeSb({ ...DRAFT_QUOTE, is_nce: true, customer_id: 'cust-1' });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });
});
