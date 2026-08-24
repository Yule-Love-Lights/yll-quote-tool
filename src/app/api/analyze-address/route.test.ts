// Audit fix (#100): assert the imagery-fetch 502 returns a GENERIC message and
// does NOT echo the raw upstream Google error (which can carry key context like
// REQUEST_DENIED / OVER_QUERY_LIMIT).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCachedAddressImagery, getAddressSatelliteImagery, NoStreetViewError } = vi.hoisted(() => ({
  getCachedAddressImagery: vi.fn(),
  getAddressSatelliteImagery: vi.fn(),
  NoStreetViewError: class NoStreetViewError extends Error {},
}));

// ledger #347: requireOperator is now engaged by default (it used to be
// dormant unless AUTH_GATE_ENABLED==='true'). This suite tests the route's own
// imagery-fallback logic, not auth, so stub it authorized like the rest of the
// route.ts test suites do.
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: vi.fn(async () => null) }));
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
  getAddressSatelliteImagery,
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
});

// #204: no Street View coverage no longer kills the whole lookup — the
// satellite leg doesn't need a pano, so the route falls back to a
// satellite-only PARTIAL SUCCESS instead of a flat 404. (This replaces the
// old all-or-nothing 404 test that used to live here — that behavior is gone.)
describe('POST /api/analyze-address — no Street View partial success (#204)', () => {
  it('falls back to satellite-only success (200) instead of 404ing the whole request', async () => {
    getCachedAddressImagery.mockRejectedValueOnce(
      new NoStreetViewError('No Street View imagery available at 123 Main St, Town, ST'),
    );
    getAddressSatelliteImagery.mockResolvedValueOnce({
      geo: { lat: 40.1, lng: -74.1, formattedAddress: '123 Main St, Town, ST' },
      satellite: { base64: 'sat-b64', mediaType: 'image/png' },
      satelliteFeetPerPixel: 0.0521,
      streetViewAvailable: false,
    });
    const res = await POST(makeReq({ address: '123 Main St' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streetViewUnavailable).toBe(true);
    expect(body.result).toBeNull();
    expect(body.satelliteBase64).toBe('sat-b64');
    expect(body.satelliteMediaType).toBe('image/png');
    expect(body.satelliteFeetPerPixel).toBe(0.0521);
    expect(body.formattedAddress).toBe('123 Main St, Town, ST');
    expect(body.lat).toBe(40.1);
    expect(body.lng).toBe(-74.1);
    // No analyzer ran — no street photo for it to look at.
    expect(body.photoBase64).toBeUndefined();
    expect(body.fewShotCount).toBeUndefined();
  });

  it('works the same way for every serviceType (permanent included) — the fallback runs before the serviceType branches', async () => {
    getCachedAddressImagery.mockRejectedValueOnce(
      new NoStreetViewError('No Street View imagery available at 9 Rural Rd, Town, ST'),
    );
    getAddressSatelliteImagery.mockResolvedValueOnce({
      geo: { lat: 41.2, lng: -75.2, formattedAddress: '9 Rural Rd, Town, ST' },
      satellite: { base64: 'sat-b64-2', mediaType: 'image/png' },
      satelliteFeetPerPixel: 0.049,
      streetViewAvailable: false,
    });
    const res = await POST(makeReq({ address: '9 Rural Rd', serviceType: 'permanent' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streetViewUnavailable).toBe(true);
    expect(body.satelliteFeetPerPixel).toBe(0.049);
    // Neither analyzer ran.
    expect(body.permanentSatellite).toBeUndefined();
    expect(body.permanentImageryOnly).toBeUndefined();
  });

  it('returns a generic 502 when BOTH Street View AND the satellite-only fallback fail', async () => {
    getCachedAddressImagery.mockRejectedValueOnce(
      new NoStreetViewError('No Street View imagery available at 123 Main St, Town, ST'),
    );
    getAddressSatelliteImagery.mockRejectedValueOnce(new Error('Static Maps outage (key=AIzaSecret)'));
    const res = await POST(makeReq({ address: '123 Main St' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Failed to fetch imagery for this address');
    expect(JSON.stringify(body)).not.toMatch(/AIzaSecret|key=/);
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
