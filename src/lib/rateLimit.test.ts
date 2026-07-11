import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { checkRateLimit, checkRateLimitByKey, __bucketSize } from './rateLimit';

// Minimal NextRequest stand-in: checkRateLimit only reads the x-forwarded-for /
// x-real-ip headers via req.headers.get(...).
function reqFromIp(ip: string): NextRequest {
  const headers = new Headers({ 'x-forwarded-for': ip });
  return { headers } as unknown as NextRequest;
}

describe('checkRateLimit — stale-entry eviction (audit #19)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts a per-IP entry once its window has fully elapsed', () => {
    const opts = { limit: 5, windowMs: 1_000, bucket: 'evict-test' };

    // IP A makes one request, then never returns.
    const a = checkRateLimit(reqFromIp('1.1.1.1'), opts);
    expect(a.ok).toBe(true);

    expect(__bucketSize('evict-test')).toBe(1);

    // Advance past the window, then a *different* IP makes a request — this is
    // the call that should sweep A's now-stale entry out of the Map.
    vi.setSystemTime(2_000);
    const b = checkRateLimit(reqFromIp('2.2.2.2'), opts);
    expect(b.ok).toBe(true);

    // A's stale entry is gone; only the active IP B remains. Without eviction
    // the Map would hold both (and grow unboundedly as IPs rotate).
    expect(__bucketSize('evict-test')).toBe(1);

    // And A, returning fresh, starts a clean window.
    const aAgain = checkRateLimit(reqFromIp('1.1.1.1'), opts);
    expect(aAgain.ok).toBe(true);
    expect(aAgain.remaining).toBe(opts.limit - 1);
  });

  it('keeps an active IP entry within the window', () => {
    const opts = { limit: 3, windowMs: 10_000, bucket: 'active-test' };

    expect(checkRateLimit(reqFromIp('9.9.9.9'), opts).remaining).toBe(2);
    // Still inside the window — the second hit must see the first timestamp.
    vi.setSystemTime(1_000);
    expect(checkRateLimit(reqFromIp('9.9.9.9'), opts).remaining).toBe(1);
    vi.setSystemTime(2_000);
    expect(checkRateLimit(reqFromIp('9.9.9.9'), opts).remaining).toBe(0);
    // Fourth hit inside the window is blocked.
    vi.setSystemTime(3_000);
    expect(checkRateLimit(reqFromIp('9.9.9.9'), opts).ok).toBe(false);
  });
});

describe('checkRateLimitByKey — arbitrary-key variant (#41 V2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps by the given key, independent of IP', () => {
    const opts = { limit: 2, windowMs: 10_000, bucket: 'keyed-test' };
    expect(checkRateLimitByKey('referral:ABCD', opts).ok).toBe(true);
    expect(checkRateLimitByKey('referral:ABCD', opts).ok).toBe(true);
    expect(checkRateLimitByKey('referral:ABCD', opts).ok).toBe(false);
    // A different key has its own independent budget.
    expect(checkRateLimitByKey('referral:WXYZ', opts).ok).toBe(true);
  });

  it('is the same underlying window/eviction logic checkRateLimit(req, opts) delegates to', () => {
    const opts = { limit: 1, windowMs: 5_000, bucket: 'delegate-test' };
    expect(checkRateLimit(reqFromIp('3.3.3.3'), opts).ok).toBe(true);
    // checkRateLimit(req) for the same IP is equivalent to checkRateLimitByKey
    // keyed on that IP — both share the bucket, so the second hit (by either
    // API) against the same effective key is blocked.
    expect(checkRateLimitByKey('3.3.3.3', opts).ok).toBe(false);
  });
});
