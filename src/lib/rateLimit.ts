// Simple in-memory sliding-window rate limiter. Keyed by IP (or fallback
// bucket). Suitable for the single-process Vercel-serverless runtime this
// project runs in — each cold-start region gets its own counter, which is
// fine as a budget-protection guardrail. Not sufficient for strong DoS
// protection; for that, put Cloudflare / Vercel Edge in front.
//
// Usage:
//   const rl = checkRateLimit(req, { limit: 10, windowMs: 60_000, bucket: 'analyze' });
//   if (!rl.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

import { NextRequest, NextResponse } from 'next/server';

type Entry = { timestamps: number[] };

// bucket → (ip → timestamps)
const buckets: Map<string, Map<string, Entry>> = new Map();

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
  const ip = getIp(req);
  const now = Date.now();
  const cutoff = now - opts.windowMs;

  let bucket = buckets.get(opts.bucket);
  if (!bucket) {
    bucket = new Map();
    buckets.set(opts.bucket, bucket);
  }

  const entry = bucket.get(ip) ?? { timestamps: [] };
  // Drop timestamps outside the window
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= opts.limit) {
    bucket.set(ip, entry);
    const oldest = entry.timestamps[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      resetMs: Math.max(0, oldest + opts.windowMs - now),
    };
  }

  entry.timestamps.push(now);
  bucket.set(ip, entry);

  return {
    ok: true,
    remaining: opts.limit - entry.timestamps.length,
    resetMs: opts.windowMs,
  };
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
      error: 'Too many requests — slow down and try again shortly.',
      retryAfterMs: rl.resetMs,
    },
    {
      status: 429,
      headers: { 'Retry-After': Math.ceil(rl.resetMs / 1000).toString() },
    },
  );
}
