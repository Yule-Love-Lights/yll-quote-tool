// #109 Phase 1: GET /api/training/prefill — projects an approved quote's design
// scene into the /training/new markup shape (a DRAFT the operator reconciles
// against the completed-install photo).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getQuoteRaw, getDesignByQuote, requireOperator } = vi.hoisted(() => ({
  getQuoteRaw: vi.fn(),
  getDesignByQuote: vi.fn(),
  requireOperator: vi.fn(async (): Promise<Response | null> => null),
}));

vi.mock('@/lib/quotes', () => ({ getQuoteRaw }));
vi.mock('@/lib/designs', () => ({ getDesignByQuote }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator }));

import { GET } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function makeReq(quoteId: string | null): NextRequest {
  const url = new URL('https://example.com/api/training/prefill');
  if (quoteId !== null) url.searchParams.set('quoteId', quoteId);
  return { nextUrl: url } as unknown as NextRequest;
}

const baseQuote = {
  id: VALID_ID,
  customer_address: '123 Main St',
  inputs: {
    santasFootage: 120,
    santasDifficulty: 'hard',
    gingerbreadFootage: 40,
    gingerbreadDifficulty: 'medium',
    winterWonderlandFootage: 20,
    winterWonderlandDifficulty: 'easy',
    stakeLightingFootage: 10,
    stakeLightingDifficulty: 'easy',
  },
};

const baseDesign = {
  id: 'd1',
  quoteId: VALID_ID,
  photoW: 1000,
  photoH: 500,
  scene: {
    yardsticks: [],
    items: [
      {
        id: 's1', yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12,
        drawingStyle: 'strand', colorPattern: ['warm-white'], points: [100, 100, 600, 100],
        surface: 'santas-roofline', included: true,
      },
      {
        id: 'ww1', yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12,
        drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 400, 1000, 400],
        surface: 'winter-wonderland', included: true,
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperator.mockResolvedValue(null);
  getQuoteRaw.mockResolvedValue(baseQuote);
  getDesignByQuote.mockResolvedValue(baseDesign);
});

describe('GET /api/training/prefill', () => {
  it('401s when the operator gate denies', async () => {
    const denied = new Response(null, { status: 401 });
    requireOperator.mockResolvedValue(denied);
    const res = await GET(makeReq(VALID_ID));
    expect(res).toBe(denied);
  });

  it('400s on a missing quoteId', async () => {
    const res = await GET(makeReq(null));
    expect(res.status).toBe(400);
  });

  it('400s on a malformed quoteId', async () => {
    const res = await GET(makeReq('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(getQuoteRaw).not.toHaveBeenCalled();
  });

  it('404s when the quote does not exist', async () => {
    getQuoteRaw.mockResolvedValue(null);
    const res = await GET(makeReq(VALID_ID));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/quote/i);
  });

  it('404s when the quote has no design', async () => {
    getDesignByQuote.mockResolvedValue(null);
    const res = await GET(makeReq(VALID_ID));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/no design/i);
  });

  it('404s when the design has no photo dims', async () => {
    getDesignByQuote.mockResolvedValue({ ...baseDesign, photoW: null, photoH: null });
    const res = await GET(makeReq(VALID_ID));
    expect(res.status).toBe(404);
  });

  it('projects the scene + quote inputs into the training markup shape, WW → c9Lines', async () => {
    const res = await GET(makeReq(VALID_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.markup.santasLines).toHaveLength(1);
    expect(json.markup.c9Lines).toHaveLength(1);
    expect(json.markup.c9Lines[0].points).toEqual([[0, 0.8], [1, 0.8]]);
    expect(json.markup.stakeLines).toEqual([]);
    expect(json.inputs).toEqual({
      santasFootage: 120,
      santasDifficulty: 'hard',
      gingerbreadFootage: 40,
      gingerbreadDifficulty: 'medium',
      winterWonderlandFootage: 20,
      winterWonderlandDifficulty: 'easy',
      stakeLightingFootage: 10,
      stakeLightingDifficulty: 'easy',
    });
    expect(json.address).toBe('123 Main St');
  });

  it('guards a corrupt/legacy difficulty value against the training corpus (falls back to preset)', async () => {
    getQuoteRaw.mockResolvedValue({
      ...baseQuote,
      inputs: { ...baseQuote.inputs, santasDifficulty: 'not-a-real-difficulty' },
    });
    const res = await GET(makeReq(VALID_ID));
    const json = await res.json();
    expect(json.inputs.santasDifficulty).toBe('medium');
  });
});
