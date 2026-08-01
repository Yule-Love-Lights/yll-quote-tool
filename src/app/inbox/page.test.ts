// #185 (inbox slowness): `timed()` is the zero-behavior-change timing wrapper
// InboxPage uses to log a single "[inbox-timing]" summary line per request. It
// wraps each of the 8 Promise.all branches — these tests cover the wrapper's
// pure arithmetic (label/value passthrough + elapsed-ms) in isolation, using
// fake timers so the elapsed time is deterministic rather than a real-wallclock
// race (mirrors src/lib/rateLimit.test.ts's vi.useFakeTimers/vi.setSystemTime
// convention).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timed } from './page';

describe('timed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the elapsed ms and preserves the label + resolved value', async () => {
    vi.setSystemTime(1_000);
    const fn = async () => {
      vi.setSystemTime(1_200);
      return 'the-value';
    };

    const result = await timed('myLabel', fn);

    expect(result).toEqual({ label: 'myLabel', ms: 200, value: 'the-value' });
  });

  it('reports 0ms when fn resolves without advancing the clock', async () => {
    vi.setSystemTime(5_000);
    const result = await timed('instant', async () => 42);
    expect(result).toEqual({ label: 'instant', ms: 0, value: 42 });
  });

  it('propagates a rejection from fn instead of swallowing it', async () => {
    vi.setSystemTime(0);
    const boom = new Error('listOpenItems failed');
    await expect(timed('listOpenItems', async () => { throw boom; })).rejects.toThrow('listOpenItems failed');
  });

  it('preserves the fn return value unchanged (including ok:false result shapes)', async () => {
    vi.setSystemTime(0);
    const shape = { ok: false as const, error: 'Supabase service role not configured' };
    const result = await timed('listOpenItems', async () => shape);
    expect(result.value).toEqual(shape);
  });
});
