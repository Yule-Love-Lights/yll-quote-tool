// #167 P1 slice 2 — /api/training/archive/imagery.
//
// The route is a thin operator-guarded shell over the worker, so what is worth
// testing is the shell: the auth gate, the two "this cannot run here" 503s, and
// that operator input reaches the worker unmangled (a wrong `limit` would
// silently over- or under-run a batch that costs real Google calls).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperator, isSupabaseServiceConfigured, isGoogleMapsConfigured, fetchArchiveImageryBatch, getArchiveImageryStatus } =
  vi.hoisted(() => ({
    requireOperator: vi.fn(async (): Promise<Response | null> => null),
    isSupabaseServiceConfigured: vi.fn(() => true),
    isGoogleMapsConfigured: vi.fn(() => true),
    fetchArchiveImageryBatch: vi.fn(),
    getArchiveImageryStatus: vi.fn(),
  }));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured }));
vi.mock('@/lib/googleMaps', () => ({ isGoogleMapsConfigured }));
vi.mock('@/lib/archiveImagery', () => ({
  fetchArchiveImageryBatch,
  getArchiveImageryStatus,
  MAX_LIMIT: 100,
}));

import { GET, POST } from './route';

function makeReq(body?: string): NextRequest {
  return { text: async () => body ?? '' } as unknown as NextRequest;
}

const RUN = { attempted: 1, fetched: 1, failed: 0, remaining: 5, stoppedOnDeadline: false, results: [] };
const STATUS = {
  properties: { total: 77, withImagery: 0, failed: 0, pending: 77 },
  photos: { total: 211, pending: 159, readyToTrace: 0, excluded: 52, other: 0 },
  needsAddress: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperator.mockResolvedValue(null);
  isSupabaseServiceConfigured.mockReturnValue(true);
  isGoogleMapsConfigured.mockReturnValue(true);
  fetchArchiveImageryBatch.mockResolvedValue(RUN);
  getArchiveImageryStatus.mockResolvedValue(STATUS);
});

describe('GET /api/training/archive/imagery', () => {
  it('returns the operator gate response when the caller is not an operator', async () => {
    requireOperator.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await GET()).status).toBe(401);
    expect(getArchiveImageryStatus).not.toHaveBeenCalled();
  });

  it('503s without the service role rather than reporting an empty queue', async () => {
    isSupabaseServiceConfigured.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(getArchiveImageryStatus).not.toHaveBeenCalled();
  });

  it('reports the queue counters and whether imagery can actually be fetched here', async () => {
    isGoogleMapsConfigured.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...STATUS, googleMapsConfigured: false });
  });
});

describe('POST /api/training/archive/imagery', () => {
  it('returns the operator gate response when the caller is not an operator', async () => {
    requireOperator.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await POST(makeReq())).status).toBe(401);
    expect(fetchArchiveImageryBatch).not.toHaveBeenCalled();
  });

  it('503s when the Google key is missing instead of failing every property', async () => {
    isGoogleMapsConfigured.mockReturnValue(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Archive imagery requires GOOGLE_MAPS_API_KEY' });
    expect(fetchArchiveImageryBatch).not.toHaveBeenCalled();
  });

  it('treats an empty body as "run the default batch"', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RUN);
    expect(fetchArchiveImageryBatch).toHaveBeenCalledWith({ limit: undefined, retryFailed: false });
  });

  it('passes an explicit limit and retryFailed through to the worker', async () => {
    await POST(makeReq(JSON.stringify({ limit: 10, retryFailed: true })));
    expect(fetchArchiveImageryBatch).toHaveBeenCalledWith({ limit: 10, retryFailed: true });
  });

  it('rejects a malformed body and a nonsense limit', async () => {
    expect((await POST(makeReq('{not json'))).status).toBe(400);
    // Written as raw JSON text: JSON.stringify(NaN) is `null`, so building
    // these with it would quietly test the null case four times over. (NaN and
    // Infinity are not expressible in JSON at all — the route's Number.isFinite
    // check is belt-and-braces against a future non-JSON caller, not something
    // a request body can reach.)
    // 101 covers the upper bound the 400 message advertises — it used to sail
    // through and get silently clamped in the worker (pre-merge review).
    for (const limit of ['"5"', '0', '-3', 'null', 'true', '{}', '101']) {
      const res = await POST(makeReq(`{"limit": ${limit}}`));
      expect(res.status, `limit ${limit}`).toBe(400);
    }
    expect(fetchArchiveImageryBatch).not.toHaveBeenCalled();
  });
});
