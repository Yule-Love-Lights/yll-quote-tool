// Tests for POST /api/quote input validation (audit fix quote-route-validation).
// Proves: (1) a non-UUID quoteId routes to insert (saveQuote) not update; a real
// UUID routes to update. (2) an over-cap array (>500) is a 400. (3) a malformed
// typed element (e.g. a wreath with a bad size) is a clean 400, not a 500.
// The data layer (saveQuote/updateQuote) + designs are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { save, update } = vi.hoisted(() => ({
  save: vi.fn(async () => ({ id: 'new-id' })),
  update: vi.fn(async () => ({ id: 'existing-id' })),
}));

vi.mock('@/lib/quotes', () => ({
  saveQuote: save,
  updateQuote: update,
}));

// No design linked in these tests → isValidDesignId false, getDesign untouched.
vi.mock('@/lib/designs', () => ({
  isValidDesignId: () => false,
  getDesign: vi.fn(),
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
