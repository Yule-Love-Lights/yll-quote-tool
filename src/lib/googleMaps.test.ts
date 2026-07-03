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
