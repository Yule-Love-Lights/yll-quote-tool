// #250 review fix (LOW): the send route's Promise.allSettled isolation was
// already proven by route.test.ts, but nothing pinned logQuoteDelivery's OWN
// try/catch — a system-level test that masks a rethrow inside allSettled
// would still pass even if this function's isolation were removed. These
// tests exercise logQuoteDelivery() directly, with no allSettled in the way,
// so a regression here can only be caught by this file.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

import { logQuoteDelivery } from './quoteDeliveries';

describe('logQuoteDelivery (#250) — best-effort, never breaks the caller', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves (does not reject) when sb.from().insert() throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sbRef.current = {
      from: () => ({
        insert: () => {
          throw new Error('connection reset');
        },
      }),
    };

    await expect(
      logQuoteDelivery({ quoteId: 'q1', channel: 'sms', outcome: 'sent' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('resolves (and warns, not throws) when the insert returns a Supabase-shaped { error }', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sbRef.current = {
      from: () => ({
        // #264: the real call chains `.insert(...).abortSignal(...)` — the
        // fake builder must offer .abortSignal() on insert()'s return value
        // (a real postgrest-js PostgrestFilterBuilder does) so this exercises
        // the intended Supabase-{error} path instead of accidentally throwing
        // on a missing method (which the outer catch would also swallow,
        // making the test pass for the wrong reason).
        insert: () => ({
          abortSignal: async () => ({ data: null, error: { message: 'relation "quote_deliveries" does not exist' } }),
        }),
      }),
    };

    await expect(
      logQuoteDelivery({ quoteId: 'q1', channel: 'email', outcome: 'failed', error: 'GHL 500' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  // #264: the insert previously had no timeout — a hung DB connection stalled
  // the caller (POST /api/quotes/[id]/send) indefinitely. Proves the
  // AbortSignal passed to .abortSignal() actually fires within the 5s
  // deadline, and that logQuoteDelivery still resolves cleanly (never
  // throws/hangs) once it does — mirrors valorVault.test.ts's "a hung request
  // times out" pattern (a fetch/query that only settles once the signal
  // fires, not one that never resolves at all).
  it('the insert is bounded by a 5s deadline — a hung connection resolves, never hangs', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedSignal: AbortSignal | undefined;
    sbRef.current = {
      from: () => ({
        insert: () => ({
          abortSignal: (signal: AbortSignal) => {
            capturedSignal = signal;
            return new Promise((resolve) => {
              signal.addEventListener('abort', () =>
                resolve({ data: null, error: { message: 'FetchError: The user aborted a request.' } }),
              );
            });
          },
        }),
      }),
    };

    const pending = logQuoteDelivery({ quoteId: 'q1', channel: 'sms', outcome: 'sent' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toBeUndefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
