// Tests for POST /api/referrals/unconsume (ledger #41 adversarial-review MED
// fix — "Remove referral credit"). getQuoteRaw / releaseCredits are mocked —
// their OWN logic is covered in src/lib/quotes.test.ts and
// src/lib/referrals.test.ts. This route's job is the wiring + the same
// money-safety validation as /api/referrals/consume: reject a mismatched
// customer/quote pair or a test quote BEFORE mutating anything.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, isSupabaseServiceConfiguredMock, getQuoteRawMock, releaseCreditsMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  isSupabaseServiceConfiguredMock: vi.fn(() => true),
  getQuoteRawMock: vi.fn(async (): Promise<unknown> => null),
  releaseCreditsMock: vi.fn(async () => ({
    released: false,
    releasedRowIds: [] as string[],
    releasedUsd: 0,
  })),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: isSupabaseServiceConfiguredMock }));
vi.mock('@/lib/quotes', () => ({ getQuoteRaw: getQuoteRawMock }));
vi.mock('@/lib/referrals', () => ({ releaseCredits: releaseCreditsMock }));

import { POST } from './route';

const CUSTOMER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const QUOTE_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  isSupabaseServiceConfiguredMock.mockReturnValue(true);
  getQuoteRawMock.mockResolvedValue({ id: QUOTE_ID, customer_id: CUSTOMER_ID, is_test: false });
  releaseCreditsMock.mockResolvedValue({ released: true, releasedRowIds: ['r1', 'r2'], releasedUsd: 250 });
});

describe('POST /api/referrals/unconsume', () => {
  it('400s on a malformed customerId', async () => {
    const res = await POST(makeReq({ customerId: 'not-a-uuid', quoteId: QUOTE_ID }));
    expect(res.status).toBe(400);
    expect(releaseCreditsMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed quoteId', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(releaseCreditsMock).not.toHaveBeenCalled();
  });

  it('404s when the quote does not exist', async () => {
    getQuoteRawMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(404);
    expect(releaseCreditsMock).not.toHaveBeenCalled();
  });

  it('400s when the quote is not linked to that customer — never releases', async () => {
    getQuoteRawMock.mockResolvedValueOnce({ id: QUOTE_ID, customer_id: 'a-different-customer', is_test: false });
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(400);
    expect(releaseCreditsMock).not.toHaveBeenCalled();
  });

  it('400s when the quote is a test quote — never releases', async () => {
    getQuoteRawMock.mockResolvedValueOnce({ id: QUOTE_ID, customer_id: CUSTOMER_ID, is_test: true });
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(400);
    expect(releaseCreditsMock).not.toHaveBeenCalled();
  });

  it('calls releaseCredits with the customer + quote and returns the released amount', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(releaseCreditsMock).toHaveBeenCalledWith(CUSTOMER_ID, QUOTE_ID);
    expect(json).toEqual({ ok: true, released: true, releasedRowIds: ['r1', 'r2'], releasedUsd: 250 });
  });

  it('is idempotent — a second call that finds nothing left to release still 200s (no error)', async () => {
    releaseCreditsMock.mockResolvedValueOnce({ released: false, releasedRowIds: [], releasedUsd: 0 });
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, released: false, releasedRowIds: [], releasedUsd: 0 });
  });

  it('is operator-gated — denied when requireOperator refuses', async () => {
    const denial = new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denial);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(401);
    expect(releaseCreditsMock).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const req = { json: async () => { throw new Error('bad json'); } } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('503s when Supabase service role is not configured', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValueOnce(false);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, quoteId: QUOTE_ID }));
    expect(res.status).toBe(503);
    expect(releaseCreditsMock).not.toHaveBeenCalled();
  });
});
