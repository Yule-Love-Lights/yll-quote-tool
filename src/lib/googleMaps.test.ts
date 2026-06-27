import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from './googleMaps';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
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
