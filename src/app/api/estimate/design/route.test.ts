import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getDesignByQuoteMock } = vi.hoisted(() => ({
  getDesignByQuoteMock: vi.fn(),
}));

vi.mock('@/lib/selfServe/estimateFlag', () => ({ isSelfServeEstimateEnabled: () => true }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/designs', () => ({
  getDesignByQuote: getDesignByQuoteMock,
  isValidDesignId: (id: unknown) =>
    typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
}));

import { GET } from './route';

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const PHOTO_URL = 'https://private-storage.test/hidden-house.jpg';

function request() {
  return new NextRequest(`https://example.test/api/estimate/design?quoteId=${QUOTE_ID}`);
}

function design(portalShowStreetView: boolean) {
  return {
    scene: { yardsticks: [], items: [{ id: 'roofline' }] },
    photoUrl: PHOTO_URL,
    photoW: 800,
    photoH: 600,
    portalShowStreetView,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/estimate/design portal visibility', () => {
  it('returns the completed self-serve design while the house view is visible', async () => {
    getDesignByQuoteMock.mockResolvedValue(design(true));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true, photoUrl: PHOTO_URL });
  });

  it('never returns a signed house URL after staff hide the house view', async () => {
    getDesignByQuoteMock.mockResolvedValue(design(false));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ready: false });
    expect(JSON.stringify(body)).not.toContain(PHOTO_URL);
  });
});
