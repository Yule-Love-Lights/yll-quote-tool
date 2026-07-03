// Tests for POST /api/quote input validation (audit fix quote-route-validation).
// Proves: (1) a non-UUID quoteId routes to insert (saveQuote) not update; a real
// UUID routes to update. (2) an over-cap array (>500) is a 400. (3) a malformed
// typed element (e.g. a wreath with a bad size) is a clean 400, not a 500.
// The data layer (saveQuote/updateQuote) + designs are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { save, update, getRaw, rawRef, operatorRef } = vi.hoisted(() => ({
  save: vi.fn(async () => ({ id: 'new-id' })),
  update: vi.fn(async () => ({ id: 'existing-id' })),
  // getQuoteRaw is consulted only on the update branch (W1-003 booked-re-price
  // gate). rawRef.current is the row the mock returns; null = row not found,
  // undefined default = a plain draft (no lifecycle timestamps → not booked).
  getRaw: vi.fn(async () => rawRef.current),
  rawRef: {
    current: null as {
      quote_sent_at: string | null;
      customer_approved_at: string | null;
      deposit_paid_at: string | null;
      viewed_at?: string | null;
      status?: string | null;
    } | null,
  },
  operatorRef: { current: null as { id: string; email: string | null; role: string } | null },
}));

vi.mock('@/lib/quotes', () => ({
  saveQuote: save,
  updateQuote: update,
  getQuoteRaw: getRaw,
}));

// No design linked in these tests → isValidDesignId false, getDesign untouched.
vi.mock('@/lib/designs', () => ({
  isValidDesignId: () => false,
  getDesign: vi.fn(),
}));

// Auth: gate allows (requireOperator → null); getOperator returns whatever the
// test sets, so we can assert the actor id is threaded to saveQuote as created_by.
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
  getOperator: async () => operatorRef.current,
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

// A minimal but fully-valid inputs object that prices cleanly.
function validInputs(): Record<string, unknown> {
  return {
    santasFootage: 0,
    gingerbreadFootage: 0,
    winterWonderlandFootage: 0,
    stakeLightingFootage: 0,
    santasDifficulty: 'easy',
    gingerbreadDifficulty: 'easy',
    winterWonderlandDifficulty: 'easy',
    stakeLightingDifficulty: 'easy',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
  };
}

const REAL_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  vi.clearAllMocks();
  operatorRef.current = null;
  // Default the update-branch row to a plain draft (no lifecycle timestamps) so
  // the existing UUID→update tests still re-price; booked/terminal cases set it.
  rawRef.current = {
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    viewed_at: null,
    status: null,
  };
});

describe('POST /api/quote — validation hardening', () => {
  it('routes a non-UUID quoteId to insert, not update', async () => {
    // 36 dashes used to slip past the old loose /^[0-9a-f-]{36}$/i regex.
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: '-'.repeat(36) }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('routes a canonical UUID quoteId to update', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an over-cap input array (length 501) with 400', async () => {
    const inputs = validInputs();
    inputs.spritzers = Array.from({ length: 501 }, () => ({ size: '16', quantity: 1 }));
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a malformed wreath element with 400', async () => {
    const inputs = validInputs();
    inputs.wreaths = [{ size: 'not-a-size', tier: 'bow', quantity: 1 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('accepts a well-formed wreath element', async () => {
    const inputs = validInputs();
    inputs.wreaths = [{ size: '24noble', tier: 'fullDecor', quantity: 2 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid custom $/ft override (#102)', async () => {
    const inputs = validInputs();
    inputs.santasFootage = 100;
    inputs.santasCustomRate = 5;
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-numeric / out-of-range custom $/ft with 400 (#102)', async () => {
    for (const bad of ['5', -1, 1001, NaN, Infinity]) {
      vi.clearAllMocks();
      const inputs = validInputs();
      inputs.stakeLightingCustomRate = bad;
      const res = await POST(makeReq({ inputs }));
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('accepts a valid lineItemPriceOverrides map (#104)', async () => {
    const inputs = validInputs();
    inputs.lineItemPriceOverrides = { 'spritzer-1': { amount: 0, reason: 'comp' }, 'roofline-santas': { amount: 600 } };
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('returns a baseline with the overrides stripped (#104)', async () => {
    const inputs = validInputs();
    inputs.spritzers = [{ size: '24', quantity: 1, id: 'spritzer-x' }];
    inputs.lineItemPriceOverrides = { 'spritzer-x': { amount: 0 } };
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { lineItems: { id?: string; amount: number }[] };
      baseline: { lineItems: { id?: string; amount: number }[] };
    };
    expect(body.result.lineItems.find((li) => li.id === 'spritzer-x')!.amount).toBe(0); // override applied
    expect(body.baseline.lineItems.find((li) => li.id === 'spritzer-x')!.amount).toBe(95); // baseline stripped
  });

  it('rejects a malformed lineItemPriceOverrides with 400 (#104)', async () => {
    const bads: unknown[] = [
      [], // array, not object
      { x: 5 }, // value not an object
      { x: { amount: -1 } }, // negative
      { x: { amount: NaN } }, // NaN
      { x: { amount: 'free' } }, // non-number
      { x: { amount: 5, reason: 42 } }, // non-string reason
    ];
    for (const bad of bads) {
      vi.clearAllMocks();
      const inputs = validInputs();
      inputs.lineItemPriceOverrides = bad;
      const res = await POST(makeReq({ inputs }));
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    }
  });
});

describe('POST /api/quote — created_by actor trail (#90)', () => {
  it('threads the authenticated operator id to saveQuote as created_by', async () => {
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    // saveQuote(customer, inputs, result, serviceType, isTest, created_by)
    expect(save).toHaveBeenCalledWith(
      expect.anything(), // customer
      expect.anything(), // inputs
      expect.anything(), // result
      expect.anything(), // serviceType
      expect.anything(), // isTest
      'op-1', // created_by
    );
  });

  it('threads null when no operator session (dormant auth)', async () => {
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      null,
    );
  });
});

describe('POST /api/quote — Test Quote flag (#93)', () => {
  it('threads isTest=true into the NEW-save path (saveQuote 5th arg)', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), isTest: true }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    // saveQuote(customer, inputs, result, serviceType, isTest)
    expect((save.mock.calls[0] as unknown[])[4]).toBe(true);
  });

  it('defaults isTest=false when the flag is absent', async () => {
    const res = await POST(makeReq({ inputs: validInputs() }));
    expect(res.status).toBe(200);
    expect((save.mock.calls[0] as unknown[])[4]).toBe(false);
  });

  it('does NOT pass is_test to the update branch (immutable on edit)', async () => {
    // An edit (canonical UUID) with isTest:true must still not re-flag the row —
    // updateQuote takes no is_test arg; the route only honors it on a fresh save.
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID, isTest: true }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('400s on a non-boolean isTest', async () => {
    const res = await POST(makeReq({ inputs: validInputs(), isTest: 'yes' }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('POST /api/quote — curtain minilight validation (W1-002)', () => {
  // The projection emits {type:'curtain'} mini inputs (#100); a design-linked
  // quote persists them, so on reopen the route must accept a curtain-typed
  // minilight instead of 400ing 'Invalid miniLightItems element'.
  it('accepts a curtain-typed minilight element (no longer 400)', async () => {
    const inputs = validInputs();
    inputs.miniLightItems = [{ type: 'curtain', wrapStyle: 'canopy', stringCount: 1 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('still 400s a minilight with an unknown type', async () => {
    const inputs = validInputs();
    inputs.miniLightItems = [{ type: 'not-a-type', wrapStyle: 'canopy', stringCount: 1 }];
    const res = await POST(makeReq({ inputs }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('POST /api/quote — booked-quote re-price gate (W1-003)', () => {
  // A booked (deposit-paid) or terminal quote must NOT be silently re-priced in
  // place — that path skips the amendment trail + invoice re-sync + re-consent.
  // The route rejects it with 409 and points at the amend flow; draft/sent/etc.
  // still re-price fine.
  it('rejects re-pricing a booked (deposit-paid) quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: '2026-01-03T00:00:00Z',
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'booked',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(typeof body.error).toBe('string');
    expect(body.code).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects re-pricing a cancelled (terminal) quote with 409', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      viewed_at: null,
      status: 'cancelled',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('still re-prices a draft quote in place', async () => {
    // rawRef defaults to a plain draft in beforeEach.
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still re-prices a sent quote in place', async () => {
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      viewed_at: null,
      status: 'sent',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still re-prices an approved-but-unbooked quote in place', async () => {
    // Approved (signed) but no deposit yet — staff can still legitimately re-price
    // before booking; only a paid deposit or a terminal state locks it.
    rawRef.current = {
      quote_sent_at: '2026-01-01T00:00:00Z',
      customer_approved_at: '2026-01-02T00:00:00Z',
      deposit_paid_at: null,
      viewed_at: '2026-01-01T00:00:00Z',
      status: 'approved',
    };
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
