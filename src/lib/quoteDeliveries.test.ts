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

import { logQuoteDelivery, fetchLatestDeliveryOutcomes } from './quoteDeliveries';

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

// Row 269: the read side of the same table — the alreadySent short-circuit
// (send route) uses this to scope its redeliver offer to only the
// channel(s) that didn't confirm-deliver. Same best-effort contract as
// logQuoteDelivery above: never throws, returns null on any failure.
describe('fetchLatestDeliveryOutcomes (row 269) — best-effort, never throws', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function fakeSelect(result: { data: unknown; error: unknown } | (() => Promise<{ data: unknown; error: unknown }>)) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              abortSignal: async () =>
                typeof result === 'function' ? await result() : result,
            }),
          }),
        }),
      }),
    };
  }

  it('returns null when no Supabase client is configured', async () => {
    sbRef.current = null;
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toBeNull();
  });

  it('returns null when the query returns a Supabase-shaped { error }', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sbRef.current = fakeSelect({ data: null, error: { message: 'relation does not exist' } });
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('resolves null (does not reject) when the query throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sbRef.current = {
      from: () => {
        throw new Error('connection reset');
      },
    };
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('no rows ever logged for this quote — both channels null (not the same as a fetch failure)', async () => {
    sbRef.current = fakeSelect({ data: [], error: null });
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toEqual({ sms: null, email: null });
  });

  it('picks the LATEST row per channel — rows are newest-first, so the first occurrence wins', async () => {
    sbRef.current = fakeSelect({
      data: [
        { channel: 'sms', outcome: 'sent', error: null, created_at: '2026-08-14T00:00:00Z' },
        { channel: 'email', outcome: 'failed', error: 'timeout — delivery outcome unknown', created_at: '2026-08-14T00:00:00Z' },
        // Older rows for the same channels — must be ignored.
        { channel: 'sms', outcome: 'failed', error: 'rate limited', created_at: '2026-08-13T00:00:00Z' },
        { channel: 'email', outcome: 'sent', error: null, created_at: '2026-08-13T00:00:00Z' },
      ],
      error: null,
    });
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toEqual({
      sms: { outcome: 'sent', error: null, at: '2026-08-14T00:00:00Z' },
      email: { outcome: 'failed', error: 'timeout — delivery outcome unknown', at: '2026-08-14T00:00:00Z' },
    });
  });

  it('only one channel ever attempted — the other stays null', async () => {
    sbRef.current = fakeSelect({
      data: [{ channel: 'sms', outcome: 'sent', error: null, created_at: '2026-08-14T00:00:00Z' }],
      error: null,
    });
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toEqual({
      sms: { outcome: 'sent', error: null, at: '2026-08-14T00:00:00Z' },
      email: null,
    });
  });

  // Row 269 fix round FIX 6 (technical LOW): two previously-untested
  // branches.
  it('postgrest-shape anomaly: data is null AND error is null — returns null, does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sbRef.current = fakeSelect({ data: null, error: null });
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toBeNull();
    // error is falsy here, so the `if (error) console.warn(...)` branch
    // inside the null/non-array guard must NOT fire — only the malformed
    // {error} case above warns.
    expect(warn).not.toHaveBeenCalled();
  });

  it('a row with an unexpected channel value is ignored — not crashed on, not mis-bucketed into sms/email', async () => {
    sbRef.current = fakeSelect({
      data: [
        { channel: 'fax', outcome: 'sent', error: null, created_at: '2026-08-14T00:00:01Z' },
        { channel: 'sms', outcome: 'sent', error: null, created_at: '2026-08-14T00:00:00Z' },
      ],
      error: null,
    });
    await expect(fetchLatestDeliveryOutcomes('q1')).resolves.toEqual({
      sms: { outcome: 'sent', error: null, at: '2026-08-14T00:00:00Z' },
      email: null,
    });
  });

  it('the query is bounded by a 5s deadline — a hung connection resolves null, never hangs', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedSignal: AbortSignal | undefined;
    sbRef.current = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
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
        }),
      }),
    };

    const pending = fetchLatestDeliveryOutcomes('q1');
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toBeNull();
    expect(capturedSignal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
