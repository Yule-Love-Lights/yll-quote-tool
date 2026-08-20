// Simple in-memory sliding-window rate limiter. Keyed by IP (or fallback
// bucket). Suitable for the single-process Vercel-serverless runtime this
// project runs in (each cold-start region gets its own counter, which is
// fine as a budget-protection guardrail). Not sufficient for strong DoS
// protection; for that, put Cloudflare / Vercel Edge in front.
//
// Usage:
//   const rl = checkRateLimit(req, { limit: 10, windowMs: 60_000, bucket: 'analyze' });
//   if (!rl.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

import { NextRequest, NextResponse } from 'next/server';

type Entry = { timestamps: number[] };

// bucket → (ip → timestamps)
const buckets: Map<string, Map<string, Entry>> = new Map();

/**
 * Test-only: number of per-IP keys currently retained in a bucket. Used to
 * assert the audit-#19 eviction keeps the Map bounded to active IPs. Returns 0
 * for an unknown bucket. Not part of the runtime rate-limiting API.
 */
export function __bucketSize(bucket: string): number {
  return buckets.get(bucket)?.size ?? 0;
}

function getIp(req: NextRequest): string {
  // Vercel forwards the real client IP in x-forwarded-for (first value).
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export type RateLimitOpts = {
  limit: number;
  windowMs: number;
  bucket: string;
};

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetMs: number;
};

export function checkRateLimit(req: NextRequest, opts: RateLimitOpts): RateLimitResult {
  return checkRateLimitByKey(getIp(req), opts);
}

// Same sliding-window logic as checkRateLimit, keyed on an arbitrary
// caller-supplied string instead of the request's IP. Extracted (#41 V2) so a
// caller can cap by something other than IP (e.g. a per-referral-code daily
// cap alongside the per-IP one), while sharing the exact same windowing +
// eviction behavior instead of a second hand-rolled copy. checkRateLimit(req,
// opts) is just checkRateLimitByKey(getIp(req), opts); existing callers are
// unaffected.
export function checkRateLimitByKey(key: string, opts: RateLimitOpts): RateLimitResult {
  const now = Date.now();
  const cutoff = now - opts.windowMs;

  let bucket = buckets.get(opts.bucket);
  if (!bucket) {
    bucket = new Map();
    buckets.set(opts.bucket, bucket);
  }

  // Audit fix (#19): evict per-key entries whose timestamps have all aged
  // out, so the Map stays bounded to currently-active keys. Without this,
  // every key that ever made a request leaves a permanent entry (an attacker
  // rotating keys grows the Map unboundedly within a warm lambda). Pure
  // hardening, no behavior change for real, in-window traffic.
  for (const [bucketKey, bucketEntry] of bucket) {
    bucketEntry.timestamps = bucketEntry.timestamps.filter(t => t > cutoff);
    if (bucketEntry.timestamps.length === 0) bucket.delete(bucketKey);
  }

  const entry = bucket.get(key) ?? { timestamps: [] };

  if (entry.timestamps.length >= opts.limit) {
    bucket.set(key, entry);
    const oldest = entry.timestamps[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      resetMs: Math.max(0, oldest + opts.windowMs - now),
    };
  }

  entry.timestamps.push(now);
  bucket.set(key, entry);

  return {
    ok: true,
    remaining: opts.limit - entry.timestamps.length,
    resetMs: opts.windowMs,
  };
}

// Review fix 4b (naldo/referral-link-personalized review round): undoes a
// single just-consumed slot for `key`, restoring the state to what it was
// immediately before that check ran. For a caller that optimistically
// checks-and-consumes before attempting a fallible action (e.g. sending an
// email), and wants to give the slot back when that action fails, so a
// transient failure doesn't lock the caller out for the rest of the
// window having accomplished nothing. Removes only the single most recent
// timestamp for this key, not the whole entry, so a caller that made
// several successful calls in the same window and then had only its LAST
// one fail keeps the earlier ones counted. No-op if the key or bucket
// doesn't exist (nothing to release).
export function releaseRateLimitByKey(key: string, opts: Pick<RateLimitOpts, 'bucket'>): void {
  const bucket = buckets.get(opts.bucket);
  if (!bucket) return;
  const entry = bucket.get(key);
  if (!entry || entry.timestamps.length === 0) return;
  entry.timestamps.pop();
  if (entry.timestamps.length === 0) bucket.delete(key);
}

// Convenience wrapper: returns a NextResponse 429 when the limit is hit,
// else null (caller proceeds). Keeps route handlers short.
export function rateLimitResponse(
  req: NextRequest,
  opts: RateLimitOpts,
): NextResponse | null {
  const rl = checkRateLimit(req, opts);
  if (rl.ok) return null;
  return NextResponse.json(
    {
      error: 'Too many requests, slow down and try again shortly.',
      retryAfterMs: rl.resetMs,
    },
    {
      status: 429,
      headers: { 'Retry-After': Math.ceil(rl.resetMs / 1000).toString() },
    },
  );
}
