import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchWithTimeout, geocodeAddress } from './googleMaps';

const realFetch = global.fetch;
const realKey = process.env.GOOGLE_MAPS_API_KEY;
afterEach(() => {
  global.fetch = realFetch;
  process.env.GOOGLE_MAPS_API_KEY = realKey;
  vi.restoreAllMocks();
});

describe('fetchWithTimeout', () => {
  it('aborts a hung request after the timeout instead of stalling forever', async () => {
    // A fetch that never resolves on its own — only settles when aborted.
    global.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as typeof fetch;

    await expect(
      fetchWithTimeout('https://maps.googleapis.com/x?key=SECRET', {}, 20),
    ).rejects.toThrow(/timed out/i);
  });

  it('never leaks the API key (query string) in the timeout error', async () => {
    global.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as typeof fetch;

    let err: Error | undefined;
    try {
      await fetchWithTimeout('https://maps.googleapis.com/x?key=SUPER_SECRET_KEY', {}, 20);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/timed out/i);
    expect(err?.message).not.toContain('SUPER_SECRET_KEY');
  });

  it('returns the response when it resolves before the timeout', async () => {
    global.fetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as typeof fetch;
    const res = await fetchWithTimeout('https://maps.googleapis.com/x', {}, 1000);
    expect(res.ok).toBe(true);
  });
});

// #110 W5-013 (cost): analyze-address re-billed geocode + Street View +
// satellite on every call, even for a repeat of the same address. Cache the
// full imagery bundle by a normalized address key with a short TTL.
describe('getCachedAddressImagery (#110 W5-013)', () => {
  let calls = 0;

  beforeEach(async () => {
    calls = 0;
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    global.fetch = (async (url: string) => {
      calls++;
      if (url.includes('/geocode/')) {
        return new Response(JSON.stringify({
          status: 'OK',
          results: [{ geometry: { location: { lat: 40.1, lng: -74.1 } }, formatted_address: '123 Main St, Town, ST' }],
        }), { status: 200 });
      }
      if (url.includes('/streetview/metadata')) {
        return new Response(JSON.stringify({ status: 'OK', pano_id: 'p1', location: { lat: 40.1, lng: -74.1 } }), { status: 200 });
      }
      // streetview or staticmap tile — binary image
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    const { __clearImageryCache } = await import('./googleMaps');
    __clearImageryCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-fetches on the first call for an address', async () => {
    const { getCachedAddressImagery } = await import('./googleMaps');
    await getCachedAddressImagery('123 Main St');
    expect(calls).toBeGreaterThan(0);
  });

  it('captures the pano camera coords for orientation (S25)', async () => {
    const { getCachedAddressImagery } = await import('./googleMaps');
    const img = await getCachedAddressImagery('123 Main St');
    expect(img.panoLocation).toEqual({ lat: 40.1, lng: -74.1 });
  });

  it('serves a repeat request for the SAME address from cache, without re-hitting Google', async () => {
    const { getCachedAddressImagery } = await import('./googleMaps');
    await getCachedAddressImagery('123 Main St');
    const firstCalls = calls;
    await getCachedAddressImagery('123 Main St');
    expect(calls).toBe(firstCalls); // no new network calls
  });

  it('normalizes case/whitespace so the same address still hits the cache', async () => {
    const { getCachedAddressImagery } = await import('./googleMaps');
    await getCachedAddressImagery('123 Main St');
    const firstCalls = calls;
    await getCachedAddressImagery('  123 MAIN ST  ');
    expect(calls).toBe(firstCalls);
  });

  it('fetches fresh for a DIFFERENT address', async () => {
    const { getCachedAddressImagery } = await import('./googleMaps');
    await getCachedAddressImagery('123 Main St');
    const firstCalls = calls;
    await getCachedAddressImagery('456 Oak Ave');
    expect(calls).toBeGreaterThan(firstCalls);
  });

  it('re-fetches once the cache entry has expired', async () => {
    vi.useFakeTimers();
    try {
      const { getCachedAddressImagery, __ADDRESS_CACHE_TTL_MS } = await import('./googleMaps');
      await getCachedAddressImagery('123 Main St');
      const firstCalls = calls;
      vi.advanceTimersByTime(__ADDRESS_CACHE_TTL_MS + 1000);
      await getCachedAddressImagery('123 Main St');
      expect(calls).toBeGreaterThan(firstCalls);
    } finally {
      vi.useRealTimers();
    }
  });
});

// W5-023: geocodeAddress's empty-result / non-OK-status guard decides the
// seed's map location — no test previously covered it (only fetchWithTimeout
// was exercised).
describe('geocodeAddress', () => {
  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  });

  it('resolves lat/lng/formattedAddress on a successful geocode', async () => {
    global.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'OK',
            results: [{ geometry: { location: { lat: 40.7, lng: -73.9 } }, formatted_address: '1 Main St' }],
          }),
          { status: 200 },
        ),
      )) as typeof fetch;

    const result = await geocodeAddress('1 Main St');
    expect(result).toEqual({ lat: 40.7, lng: -73.9, formattedAddress: '1 Main St' });
  });

  it('throws when the HTTP response is not ok', async () => {
    global.fetch = (() => Promise.resolve(new Response('', { status: 500 }))) as typeof fetch;
    await expect(geocodeAddress('1 Main St')).rejects.toThrow(/Geocode failed: 500/);
  });

  it('throws when Google reports a non-OK status (e.g. ZERO_RESULTS)', async () => {
    global.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 }))) as typeof fetch;
    await expect(geocodeAddress('nowhere')).rejects.toThrow(/ZERO_RESULTS/);
  });

  it('throws when status is OK but results is empty', async () => {
    global.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'OK', results: [] }), { status: 200 }))) as typeof fetch;
    await expect(geocodeAddress('1 Main St')).rejects.toThrow(/Geocode failed/);
  });
});
