// Tests for POST /api/referrals/consume (redemption, ledger #41 PR 2).
// getQuoteRaw / creditBalanceFor / consumeCredits are mocked — their OWN
// logic is covered in src/lib/quotes.test.ts and src/lib/referrals.test.ts.
// This route's job is the wiring + the money-safety rule: the applied amount
// is ALWAYS server-computed (min(balance, quote subtotal)), never a
// client-supplied number.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, getQuoteRawMock, creditBalanceForMock, consumeCreditsMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getQuoteRawMock: vi.fn(async (): Promise<unknown> => null),
  creditBalanceForMock: vi.fn(async () => 0),
  consumeCreditsMock: vi.fn(async () => ({
    consumed: false,
    consumedRowIds: [] as string[],
    consumedUsd: 0,
    newBalanceUsd: 0,
  })),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/quotes', () => ({ getQuoteRaw: getQuoteRawMock }));
vi.mock('@/lib/referrals', () => ({
  creditBalanceFor: creditBalanceForMock,
  consumeCredits: consumeCreditsMock,
}));

import { POST } from './route';

const CUSTOMER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const QUOTE_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getQuoteRawMock.mockResolvedValue({ id: QUOTE_ID, customer_id: CUSTOMER_ID, is_test: false, result: { subtotalBeforeDiscount: 2000 } });
  creditBalanceForMock.mockResolvedValue(250);
  consumeCreditsMock.mockResolvedValue({
    consumed: true,
    consumedRowIds: ['r1', 'r2'],
    consumedUsd: 250,
    newBalanceUsd: 0,
  });
});

describe('POST /api/referrals/consume', () => {
  it('400s on a malformed customerId', async () => {
    const res = await POST(makeReq({ customerId: 'not-a-uuid', quoteId: QUOTE_ID }));
    expect(res.status).toBe(400);
  });

  it('400s on a malformed quoteId', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    getQuoteRawMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(404);
  });

  // #41 adversarial-review LOW fix: reject before ever touching the balance/
  // consume paths — a mismatched pair or a test quote must never mutate the
  // real referral ledger.
  it('400s when the quote is not linked to that customer — never checks the balance', async () => {
    getQuoteRawMock.mockResolvedValueOnce({ id: QUOTE_ID, customer_id: 'a-different-customer', is_test: false, result: { subtotalBeforeDiscount: 2000 } });
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(400);
    expect(creditBalanceForMock).not.toHaveBeenCalled();
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it('400s when the quote is a test quote — never checks the balance', async () => {
    getQuoteRawMock.mockResolvedValueOnce({ id: QUOTE_ID, customer_id: CUSTOMER_ID, is_test: true, result: { subtotalBeforeDiscount: 2000 } });
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(400);
    expect(creditBalanceForMock).not.toHaveBeenCalled();
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it('409s (no-credit) when the customer has no balance — never calls consumeCredits', async () => {
    creditBalanceForMock.mockResolvedValueOnce(0);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-credit');
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it('409s (no-subtotal) when the quote has not been Calculated yet (subtotal 0)', async () => {
    getQuoteRawMock.mockResolvedValueOnce({ id: QUOTE_ID, customer_id: CUSTOMER_ID, is_test: false, result: null });
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-subtotal');
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it('applies min(balance, subtotal) — clamps the discount to the CHEAPER quote, not the whole balance', async () => {
    getQuoteRawMock.mockResolvedValueOnce({ id: QUOTE_ID, customer_id: CUSTOMER_ID, is_test: false, result: { subtotalBeforeDiscount: 80 } });
    creditBalanceForMock.mockResolvedValueOnce(250);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.appliedUsd).toBe(80);
    expect(consumeCreditsMock).toHaveBeenCalledWith(CUSTOMER_ID, QUOTE_ID, 80);
  });

  it('applies the full balance when the quote subtotal is bigger', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.appliedUsd).toBe(250); // balance < 2000 subtotal
    expect(consumeCreditsMock).toHaveBeenCalledWith(CUSTOMER_ID, QUOTE_ID, 250);
  });

  it('returns ok + the new balance + consumed row ids on success', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(json).toEqual({ ok: true, appliedUsd: 250, consumedRowIds: ['r1', 'r2'], balanceUsd: 0 });
  });

  it('409s (no-credit) when consumeCredits reports it did not consume (lost a race)', async () => {
    consumeCreditsMock.mockResolvedValueOnce({
      consumed: false,
      consumedRowIds: [],
      consumedUsd: 0,
      newBalanceUsd: 0,
    });
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-credit');
  });

  it('is operator-gated — denied when requireOperator refuses', async () => {
    const denial = new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denial);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(401);
    expect(creditBalanceForMock).not.toHaveBeenCalled();
  });

  it('ignores any client-supplied amount field — always derives from the quote subtotal', async () => {
    // Even if a caller tried to smuggle an amount in the body, the route
    // never reads it; the clamp math above proves this is server-derived.
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID, amountUsd: 1 }));
    const json = await res.json();
    expect(json.appliedUsd).toBe(250);
  });
});
