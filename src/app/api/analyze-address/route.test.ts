// Audit fix (#100): assert the imagery-fetch 502 returns a GENERIC message and
// does NOT echo the raw upstream Google error (which can carry key context like
// REQUEST_DENIED / OVER_QUERY_LIMIT).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCachedAddressImagery, NoStreetViewError } = vi.hoisted(() => ({
  getCachedAddressImagery: vi.fn(),
  NoStreetViewError: class NoStreetViewError extends Error {},
}));

vi.mock('@/lib/claude', () => ({ isClaudeConfigured: () => true }));
vi.mock('@/lib/photoAnalysis', () => ({
  analyzePhoto: vi.fn(),
  ANALYZER_UNAVAILABLE_MESSAGE: 'unavailable',
}));
vi.mock('@/lib/fewShot', () => ({ assembleFewShot: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/googleMaps', () => ({
  isGoogleMapsConfigured: () => true,
  getCachedAddressImagery,
  NoStreetViewError,
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/analyze-address — upstream error handling', () => {
  it('returns a generic 502 and does not leak the raw Google error', async () => {
    // Throw a Google-style error with sensitive detail in the message.
    getCachedAddressImagery.mockRejectedValueOnce(
      new Error('Google Geocoding REQUEST_DENIED: API key not authorized (key=AIzaSecret)'),
    );
    const res = await POST(makeReq({ address: '123 Main St' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Failed to fetch imagery for this address');
    expect(JSON.stringify(body)).not.toMatch(/REQUEST_DENIED|AIzaSecret|key=/);
  });

  it('returns a 404 with the formatted address when no Street View coverage exists', async () => {
    getCachedAddressImagery.mockRejectedValueOnce(
      new NoStreetViewError('No Street View imagery available at 123 Main St, Town, ST'),
    );
    const res = await POST(makeReq({ address: '123 Main St' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/No Street View imagery/);
  });
});

// #117: permanent_bistro is design-drawn only — no analyzer should run (the
// client discards any analyzer result for this vertical anyway), so the route
// must short-circuit right after imagery fetch with a no-result payload.
describe('POST /api/analyze-address — permanent_bistro imagery-only path (#117)', () => {
  it('returns the imagery with no analysis result, without invoking any analyzer', async () => {
    getCachedAddressImagery.mockResolvedValueOnce({
      geo: { lat: 1.1, lng: 2.2, formattedAddress: '123 Main St, Town, ST' },
      streetView: { base64: 'street-b64', mediaType: 'image/jpeg' },
      satellite: { base64: 'sat-b64', mediaType: 'image/png' },
      satelliteFeetPerPixel: 0.5,
      panoLocation: { lat: 1.1001, lng: 2.2001 },
    });
    const res = await POST(makeReq({ address: '123 Main St', serviceType: 'permanent_bistro' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBeNull();
    expect(body.photoBase64).toBe('street-b64');
    expect(body.photoMediaType).toBe('image/jpeg');
    expect(body.satelliteBase64).toBe('sat-b64');
    expect(body.satelliteMediaType).toBe('image/png');
    expect(body.satelliteFeetPerPixel).toBe(0.5);
    expect(body.formattedAddress).toBe('123 Main St, Town, ST');
    expect(body.lat).toBe(1.1);
    expect(body.lng).toBe(2.2);
    // Neither the holiday nor the permanent-satellite analyzer ran for this vertical.
    expect(body.permanentSatellite).toBeUndefined();
    expect(body.permanentImageryOnly).toBeUndefined();
  });
});
