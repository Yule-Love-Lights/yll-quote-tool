// #15 — "move along the street" branch: step the camera to an adjacent pano,
// re-aim at the house, and report reachedEnd at coverage edges. Geometry is
// real (src/lib/geo); the Google metadata + tile fetch are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: async () => undefined }));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));

const { resolveStreetViewPano, fetchStreetView } = vi.hoisted(() => ({
  resolveStreetViewPano: vi.fn(),
  fetchStreetView: vi.fn(),
}));
vi.mock('@/lib/googleMaps', () => ({
  isGoogleMapsConfigured: () => true,
  resolveStreetViewPano,
  fetchStreetView,
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}

const HOUSE = { houseLat: 40.0, houseLng: -74.0 };
const CAM = { camLat: 40.0, camLng: -74.0 };

beforeEach(() => {
  vi.clearAllMocks();
  fetchStreetView.mockResolvedValue({ base64: 'IMG', mediaType: 'image/jpeg' });
});

describe('POST /api/streetview — move along the street (#15)', () => {
  it('steps to a distinct adjacent pano, re-aims at the house, returns the new camera', async () => {
    resolveStreetViewPano
      .mockResolvedValueOnce({ status: 'OK', panoId: 'A', lat: 40.0, lng: -74.0 })   // current
      .mockResolvedValueOnce({ status: 'OK', panoId: 'B', lat: 40.0002, lng: -74.0003 }); // stepped

    const res = await POST(makeReq({ direction: 'right', ...CAM, ...HOUSE }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.reachedEnd).toBe(false);
    expect(json.panoId).toBe('B');
    expect(json.camLat).toBe(40.0002);
    expect(json.camLng).toBe(-74.0003);
    expect(json.photoBase64).toBe('IMG');
    expect(typeof json.heading).toBe('number'); // aimed back at the house
    expect(fetchStreetView).toHaveBeenCalledWith(40.0002, -74.0003, expect.objectContaining({ heading: expect.any(Number) }));
  });

  it('reports reachedEnd when both step distances snap back to the SAME pano', async () => {
    resolveStreetViewPano
      .mockResolvedValueOnce({ status: 'OK', panoId: 'A', lat: 40.0, lng: -74.0 }) // current
      .mockResolvedValueOnce({ status: 'OK', panoId: 'A', lat: 40.0, lng: -74.0 }) // step 15m → same
      .mockResolvedValueOnce({ status: 'OK', panoId: 'A', lat: 40.0, lng: -74.0 }); // step 30m → same

    const res = await POST(makeReq({ direction: 'left', ...CAM, ...HOUSE }));
    const json = await res.json();

    expect(json.reachedEnd).toBe(true);
    expect(fetchStreetView).not.toHaveBeenCalled();
  });

  it('reports reachedEnd when the current location has no Street View coverage', async () => {
    resolveStreetViewPano.mockResolvedValueOnce({ status: 'ZERO_RESULTS' });

    const res = await POST(makeReq({ direction: 'right', ...CAM, ...HOUSE }));
    const json = await res.json();

    expect(json.reachedEnd).toBe(true);
    expect(resolveStreetViewPano).toHaveBeenCalledTimes(1); // never even stepped
    expect(fetchStreetView).not.toHaveBeenCalled();
  });

  it('400s when the camera/house coords are missing', async () => {
    const res = await POST(makeReq({ direction: 'right' }));
    expect(res.status).toBe(400);
    expect(resolveStreetViewPano).not.toHaveBeenCalled();
  });

  it('still serves the plain angle re-fetch (no direction) unchanged', async () => {
    const res = await POST(makeReq({ lat: 40.0, lng: -74.0, heading: 120 }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.photoBase64).toBe('IMG');
    expect(json.heading).toBe(120);
    expect(resolveStreetViewPano).not.toHaveBeenCalled(); // angle path doesn't snap
  });
});
