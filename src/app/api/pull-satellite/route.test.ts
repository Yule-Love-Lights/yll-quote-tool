// #204: route-level coverage for the "Pull satellite" builder action —
// geocode + satellite image + real scale, NO Claude call. Mirrors the mock
// style of analyze-address/route.test.ts and streetview/route.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { getAddressSatelliteImagery } = vi.hoisted(() => ({
  getAddressSatelliteImagery: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: async () => null }));
vi.mock('@/lib/googleMaps', () => ({
  isGoogleMapsConfigured: () => true,
  getAddressSatelliteImagery,
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/pull-satellite — happy path (#204)', () => {
  it('returns the satellite image + real scale, and nothing AI-shaped', async () => {
    getAddressSatelliteImagery.mockResolvedValueOnce({
      geo: { lat: 40.1, lng: -74.1, formattedAddress: '123 Main St, Town, ST' },
      satellite: { base64: 'sat-b64', mediaType: 'image/png' },
      satelliteFeetPerPixel: 0.0521,
      streetViewAvailable: false,
    });
    const res = await POST(makeReq({ address: '123 Main St' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.satelliteBase64).toBe('sat-b64');
    expect(body.satelliteMediaType).toBe('image/png');
    expect(body.satelliteFeetPerPixel).toBe(0.0521);
    expect(body.formattedAddress).toBe('123 Main St, Town, ST');
    expect(body.lat).toBe(40.1);
    expect(body.lng).toBe(-74.1);
    expect(body.streetViewAvailable).toBe(false);
    // No analyzer ran — this route never imports/calls Claude at all, and the
    // response carries none of the AI-result fields analyze-address returns.
    expect(body.result).toBeUndefined();
    expect(body.photoBase64).toBeUndefined();
    expect(body.fewShotCount).toBeUndefined();
  });

  it('surfaces streetViewAvailable:true when a pano DOES resolve (address has both)', async () => {
    getAddressSatelliteImagery.mockResolvedValueOnce({
      geo: { lat: 40.1, lng: -74.1, formattedAddress: '5 Elm St, Town, ST' },
      satellite: { base64: 'sat-b64-2', mediaType: 'image/png' },
      satelliteFeetPerPixel: 0.0499,
      streetViewAvailable: true,
    });
    const res = await POST(makeReq({ address: '5 Elm St' }));
    const body = await res.json();
    expect(body.streetViewAvailable).toBe(true);
  });

  it('passes the trimmed address through to getAddressSatelliteImagery', async () => {
    getAddressSatelliteImagery.mockResolvedValueOnce({
      geo: { lat: 1, lng: 2, formattedAddress: 'x' },
      satellite: { base64: 'b', mediaType: 'image/png' },
      satelliteFeetPerPixel: 0.05,
      streetViewAvailable: false,
    });
    await POST(makeReq({ address: '  123 Main St  ' }));
    expect(getAddressSatelliteImagery).toHaveBeenCalledWith('123 Main St');
  });
});

describe('POST /api/pull-satellite — validation', () => {
  it('400s when address is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(getAddressSatelliteImagery).not.toHaveBeenCalled();
  });

  it('400s when address is blank/whitespace-only', async () => {
    const res = await POST(makeReq({ address: '   ' }));
    expect(res.status).toBe(400);
    expect(getAddressSatelliteImagery).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const badReq = { json: async () => { throw new Error('bad json'); } } as unknown as NextRequest;
    const res = await POST(badReq);
    expect(res.status).toBe(400);
    expect(getAddressSatelliteImagery).not.toHaveBeenCalled();
  });
});

describe('POST /api/pull-satellite — upstream failure (bad address / Google error)', () => {
  it('returns a generic 502 and does not leak the raw Google error', async () => {
    getAddressSatelliteImagery.mockRejectedValueOnce(
      new Error('Google Geocoding REQUEST_DENIED: API key not authorized (key=AIzaSecret)'),
    );
    const res = await POST(makeReq({ address: 'not a real address at all' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Failed to fetch satellite imagery for this address');
    expect(JSON.stringify(body)).not.toMatch(/REQUEST_DENIED|AIzaSecret|key=/);
  });

  it('502s when geocoding finds zero results (bad address)', async () => {
    getAddressSatelliteImagery.mockRejectedValueOnce(new Error('Geocode failed: ZERO_RESULTS'));
    const res = await POST(makeReq({ address: 'asdkjfhaslkdjfh nowhere' }));
    expect(res.status).toBe(502);
  });
});
