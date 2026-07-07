// Tests for two audit fixes on POST /api/quote (unit amend-deadlock-and-quote-failopen):
//
// (a) AMEND DEADLOCK — a booked order's stored result is frozen by the reprice
//     lock (W1-003), so the amend flow's delta (result.total − snapshot.pricing.total)
//     is always 0 and every post-booking amend 409s "no-change" forever. The fix is
//     an explicit, operator-only `amendReprice` carve-out that lets a BOOKED order be
//     re-priced in place (result/inputs updated, lifecycle untouched). Terminal
//     statuses stay hard-locked.
// (b) FAIL-OPEN — getQuoteRaw returns null for BOTH a missing row and a read error;
//     the update branch used to fall through to updateQuote on null, skipping the
//     reprice-lock / rate-drift / stored-service-type guards and overwriting the row.
//     The fix fails CLOSED: an update whose row is null is a 404, never a silent write.
//
// The data layer (saveQuote/updateQuote/getQuoteRaw) + designs + auth + settings are
// mocked, mirroring route.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { save, update, getRaw, rawRef } = vi.hoisted(() => ({
  save: vi.fn(async (..._args: unknown[]) => ({ id: 'new-id' })),
  update: vi.fn(async (..._args: unknown[]) => ({ id: 'existing-id' })),
  getRaw: vi.fn(async () => rawRef.current),
  rawRef: {
    current: null as {
      quote_sent_at: string | null;
      customer_approved_at: string | null;
      deposit_paid_at: string | null;
      viewed_at?: string | null;
      status?: string | null;
      service_type?: string | null;
      result?: { permanentRatesSnapshot?: unknown; eventRatesSnapshot?: unknown } | null;
    } | null,
  },
}));

vi.mock('@/lib/quotes', () => ({
  saveQuote: save,
  updateQuote: update,
  getQuoteRaw: getRaw,
}));

vi.mock('@/lib/designs', () => ({
  isValidDesignId: () => false,
  getDesign: vi.fn(async () => null),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
  getOperator: async () => null,
}));

vi.mock('@/lib/appSettings', () => ({
  getAppSettings: async () => ({
    permanentRates: { frontPerFt: 40, sidesPerFt: 35, backPerFt: 35, minimumJobAmount: 2500, maintenancePrice: 0 },
    eventRates: {
      roofline: { easy: 5, medium: 5, hard: 5 },
      mini: { canopy: 20, trunk: 20 },
      spritzer: { '16': 40, '24': 40, '32': 40 },
      bistroPerFt: 8,
      barrelBoxPrice: 100,
    },
  }),
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

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

function bookedRow() {
  return {
    quote_sent_at: '2026-01-01T00:00:00Z',
    customer_approved_at: '2026-01-02T00:00:00Z',
    deposit_paid_at: '2026-01-03T00:00:00Z',
    viewed_at: '2026-01-01T00:00:00Z',
    status: 'booked',
    service_type: null,
    result: null,
  };
}

function cancelledRow() {
  return {
    quote_sent_at: '2026-01-01T00:00:00Z',
    customer_approved_at: null,
    deposit_paid_at: null,
    viewed_at: null,
    status: 'cancelled',
    service_type: null,
    result: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rawRef.current = {
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    viewed_at: null,
    status: null,
    service_type: null,
    result: null,
  };
});

describe('POST /api/quote — fail-closed on a null row for an update (audit fix b)', () => {
  it('404s an update whose row is null (missing OR read error) instead of overwriting', async () => {
    rawRef.current = null; // getQuoteRaw returns null for a missing row AND a read error
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('still inserts (saveQuote) a brand-new quote with no quoteId — the guard only applies to updates', async () => {
    rawRef.current = null;
    const res = await POST(makeReq({ inputs: validInputs() })); // no quoteId → insert
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('POST /api/quote — operator amend re-price carve-out (audit fix a)', () => {
  it('allows an amendReprice re-price of a BOOKED order (updateQuote runs, no 409)', async () => {
    rawRef.current = bookedRow();
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID, amendReprice: true }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still 409-locks a BOOKED order re-price WITHOUT amendReprice (W1-003 preserved)', async () => {
    rawRef.current = bookedRow();
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('still 409-locks a CANCELLED (terminal) order even WITH amendReprice — a dead order is never re-priced', async () => {
    rawRef.current = cancelledRow();
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID, amendReprice: true }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('a non-true amendReprice value does not unlock a booked order (only explicit true)', async () => {
    rawRef.current = bookedRow();
    const res = await POST(makeReq({ inputs: validInputs(), quoteId: REAL_UUID, amendReprice: 'yes' }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });
});
