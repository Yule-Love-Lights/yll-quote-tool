// Audit fix (#100): assert the imagery-fetch 502 returns a GENERIC message and
// does NOT echo the raw upstream Google error (which can carry key context like
// REQUEST_DENIED / OVER_QUERY_LIMIT).
import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/claude', () => ({ isClaudeConfigured: () => true }));
vi.mock('@/lib/photoAnalysis', () => ({
  analyzePhoto: vi.fn(),
  ANALYZER_UNAVAILABLE_MESSAGE: 'unavailable',
}));
vi.mock('@/lib/fewShot', () => ({ assembleFewShot: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/googleMaps', () => ({
  isGoogleMapsConfigured: () => true,
  // Throw a Google-style error with sensitive detail in the message.
  geocodeAddress: vi.fn(async () => {
    throw new Error('Google Geocoding REQUEST_DENIED: API key not authorized (key=AIzaSecret)');
  }),
  fetchStreetView: vi.fn(),
  fetchSatellite: vi.fn(),
  hasStreetView: vi.fn(),
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe('POST /api/analyze-address — upstream error handling', () => {
  it('returns a generic 502 and does not leak the raw Google error', async () => {
    const res = await POST(makeReq({ address: '123 Main St' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Failed to fetch imagery for this address');
    expect(JSON.stringify(body)).not.toMatch(/REQUEST_DENIED|AIzaSecret|key=/);
  });
});
