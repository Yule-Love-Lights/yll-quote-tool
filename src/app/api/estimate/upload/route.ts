// Customer self-serve estimate — upload-your-own-photo (ledger self-serve, S48).
//
// POST /api/estimate/upload
// Body: { photoBase64, photoMediaType?, address? }
//   { quoteId }                          — a self-serve draft was created with the
//                                          photo attached; the contact step attaches
//                                          the customer to it.
//   { error } with 404 (flag off) / 400 (bad input) / 413 (too big) / 429 / 503/502.
//
// Public, flag-gated, tightly rate-limited (each call writes a quote + a design +
// a storage upload). An uploaded photo can't auto-measure, so this routes to the
// hand-designed path — see lib/selfServe/upload.ts.

import { NextRequest, NextResponse } from 'next/server';
import { isSelfServeEstimateEnabled } from '@/lib/selfServe/estimateFlag';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { consumeAnalyzerBudget } from '@/lib/selfServe/budget';
import { createUploadQuote } from '@/lib/selfServe/upload';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024; // 10MB, matches the design/upload limits elsewhere
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(req: NextRequest) {
  if (!isSelfServeEstimateEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // Writes on every accepted call — cap hard.
  const blocked = rateLimitResponse(req, { bucket: 'self-serve-estimate-upload', limit: 6, windowMs: 60_000 });
  if (blocked) return blocked;

  let body: { photoBase64?: unknown; photoMediaType?: unknown; address?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const photoBase64 = typeof body.photoBase64 === 'string' ? body.photoBase64 : '';
  const photoMediaType = typeof body.photoMediaType === 'string' ? body.photoMediaType : 'image/jpeg';
  if (!photoBase64) {
    return NextResponse.json({ error: 'A photo is required' }, { status: 400 });
  }
  if (!ALLOWED.has(photoMediaType)) {
    return NextResponse.json({ error: 'Please upload a JPG, PNG, or WEBP image' }, { status: 400 });
  }
  // base64 decodes to ~3/4 of its length — reject oversized before decoding.
  if (photoBase64.length * 0.75 > MAX_BYTES) {
    return NextResponse.json({ error: 'That image is too large (max 10MB)' }, { status: 413 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Upload is temporarily unavailable' }, { status: 503 });
  }

  // Bound TOTAL daily self-serve writes across all IPs (the per-IP limit only
  // caps one attacker). Shares the estimate's daily budget — an uploaded photo is
  // an equally-billable public write (a quote + design + storage blob). Fails open
  // if the counter RPC isn't applied.
  const budget = await consumeAnalyzerBudget();
  if (!budget.allowed) {
    return NextResponse.json({ error: "We're getting a lot of requests right now — please try again in a bit." }, { status: 429 });
  }

  const address = typeof body.address === 'string' ? body.address.trim().slice(0, 500) : null;
  const quoteId = await createUploadQuote(photoBase64, photoMediaType, address || null).catch((err) => {
    console.error('[api/estimate/upload] failed:', err instanceof Error ? err.message : 'error');
    return null;
  });
  if (!quoteId) {
    return NextResponse.json({ error: 'Could not save your photo. Please try again.' }, { status: 502 });
  }
  return NextResponse.json({ quoteId }, { status: 200 });
}
