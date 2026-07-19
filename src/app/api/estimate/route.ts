// Customer self-serve estimate — measure + price (Phase A, ledger self-serve).
//
// POST /api/estimate
// Body: { address, houseStyle?, company?, elapsedMs? }
//   company  — honeypot (a real visitor never fills it)
//   elapsedMs — client-computed render→submit ms; under 2s = bot-fast
// Response (always 200 on a handled outcome; the UI branches on `measured`):
//   { measured: true, quoteId, low, high, formattedAddress }
//   { measured: false, reason }        — no Street View / analyzer down / not
//                                        confident / no footage → the client
//                                        shows the "leave your info, we'll finish
//                                        your custom quote" capture path.
//   { error }                          — 404 (flag off), 400 (bad input),
//                                        429 (rate limited), 502/503 (upstream).
//
// This is the SAME pipeline staff use — getCachedAddressImagery →
// runAnalyzeWithFewShot (the #8 few-shot analyzer) → calculateQuote (the holiday
// engine) — behind a public, rate-limited, flag-gated door. It NEVER shows a
// binding number: it saves an Anonymous draft (staff confirm every self-serve
// quote before the customer can pay) and returns a RANGE.

import { NextRequest, NextResponse } from 'next/server';
import { isSelfServeEstimateEnabled } from '@/lib/selfServe/estimateFlag';
import { isClaudeConfigured } from '@/lib/claude';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { runAnalyzeWithFewShot } from '@/lib/analyzeWithFewShot';
import { isGoogleMapsConfigured, getCachedAddressImagery, NoStreetViewError } from '@/lib/googleMaps';
import { calculateQuote, BUSINESS_RULES, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import { saveQuote } from '@/lib/quotes';
import {
  isMeasurable,
  analysisToHolidayInputs,
  computeEstimateRange,
} from '@/lib/selfServe/estimateRange';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TOO_FAST_MS = 2000;
const MAX_ADDRESS_LEN = 500;
const MAX_HOUSE_STYLE_LEN = 80;

// Marker stashed in the saved quote's `inputs` jsonb so staff can tell a fresh
// self-serve draft from a staff-built one. The holiday engine never reads it;
// it rides the jsonb snapshot only. (A staff re-Calculate drops it, which is
// fine — by then the quote has been reviewed and is no longer a raw draft.)
type SelfServeMeta = {
  meta: { source: 'self_serve_estimate'; estimateLow: number; estimateHigh: number; confidence: string };
};

export async function POST(req: NextRequest) {
  // Flag off → the whole feature is dark; 404 so it isn't even advertised.
  if (!isSelfServeEstimateEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Each accepted call bills Anthropic + 2 Google Maps APIs — cap hard on a
  // public endpoint. Well below the staff analyze-address 20/min.
  const blocked = rateLimitResponse(req, { bucket: 'self-serve-estimate', limit: 8, windowMs: 60_000 });
  if (blocked) return blocked;

  let body: { address?: unknown; houseStyle?: unknown; company?: unknown; elapsedMs?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Honeypot / too-fast: answer with a benign "unavailable" and do NO upstream
  // work — indistinguishable to a bot, and the expensive analyzer never runs.
  const isHoneypot = typeof body.company === 'string' && body.company.trim().length > 0;
  const isTooFast =
    typeof body.elapsedMs === 'number' && body.elapsedMs >= 0 && body.elapsedMs < TOO_FAST_MS;
  if (isHoneypot || isTooFast) {
    return NextResponse.json({ measured: false, reason: 'unavailable' }, { status: 200 });
  }

  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!address) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 });
  }
  if (address.length > MAX_ADDRESS_LEN) {
    return NextResponse.json({ error: `address must be at most ${MAX_ADDRESS_LEN} characters` }, { status: 400 });
  }
  // Capped like the contact route's fields — an uncapped hint feeds the paid
  // Anthropic analyzer (token-cost + prompt-injection surface).
  const houseStyleHint =
    typeof body.houseStyle === 'string' && body.houseStyle.trim()
      ? body.houseStyle.trim().slice(0, MAX_HOUSE_STYLE_LEN)
      : undefined;

  // Upstream config — a public customer must get a clean "try later", never a
  // stack trace, when a key is missing.
  if (!isClaudeConfigured() || !isGoogleMapsConfigured() || !isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Estimator is temporarily unavailable' }, { status: 503 });
  }

  // ── 1. Imagery (geocode + Street View + satellite) ────────────────────────
  let geo: { lat: number; lng: number; formattedAddress: string };
  let streetView: { base64: string; mediaType: 'image/jpeg' | 'image/png' };
  let satellite: { base64: string; mediaType: 'image/jpeg' | 'image/png' };
  let satelliteFeetPerPixel: number;
  try {
    ({ geo, streetView, satellite, satelliteFeetPerPixel } = await getCachedAddressImagery(address));
  } catch (err) {
    // No Street View pano for this address → not a failure, just unmeasurable.
    // Route the customer to the follow-up capture path.
    if (err instanceof NoStreetViewError) {
      return NextResponse.json({ measured: false, reason: 'no_streetview' }, { status: 200 });
    }
    console.error('[api/estimate] imagery fetch failed:', err);
    return NextResponse.json({ error: 'Could not load imagery for this address' }, { status: 502 });
  }

  // ── 2. Analyze (same #8 few-shot analyzer as staff) — FAIL-SAFE ───────────
  const { result } = await runAnalyzeWithFewShot(
    streetView.base64,
    streetView.mediaType,
    houseStyleHint,
    { satellite: { base64: satellite.base64, mediaType: satellite.mediaType, feetPerPixel: satelliteFeetPerPixel } },
    '[api/estimate]',
  );

  // ── 3. Confidence gate — never silently quote $0 ──────────────────────────
  if (!isMeasurable(result)) {
    const reason = result === null ? 'analyzer_unavailable' : result.confidence === 'low' ? 'low_confidence' : 'no_footage';
    return NextResponse.json({ measured: false, reason }, { status: 200 });
  }

  // ── 4. Price with the real engine + bracket into a customer-facing range ──
  let low: number;
  let high: number;
  let quoteInputs: QuoteInputs;
  let priced: ReturnType<typeof calculateQuote>;
  try {
    quoteInputs = analysisToHolidayInputs(result!);
    priced = calculateQuote(quoteInputs);
    // Floor the SHOWN range at the $1,000 job minimum. calculateQuote.total does
    // NOT apply that minimum (it's enforced at the portal approval gate), so a
    // small home can price below $1,000 — but the customer will still pay at
    // least the minimum, and anchoring them on a sub-$1,000 range they can never
    // actually get would be misleading. The saved draft keeps the raw engine
    // total; only the customer-facing range is floored.
    const shownTotal = Math.max(priced.total, BUSINESS_RULES.minimumQuoteAmount);
    ({ low, high } = computeEstimateRange(shownTotal));
  } catch (err) {
    console.error('[api/estimate] pricing failed:', err);
    return NextResponse.json({ error: 'Estimator is temporarily unavailable' }, { status: 503 });
  }

  // ── 5. Save an Anonymous draft (so an abandoned visit still leaves a lead) ─
  // The address is real; name/phone/email land later via /api/estimate/contact.
  // A save failure must NOT deny the customer their price — log and return the
  // range without a quoteId (the contact step then falls back to lead capture).
  let quoteId: string | null = null;
  try {
    const inputsWithMeta: QuoteInputs = {
      ...quoteInputs,
      meta: { source: 'self_serve_estimate', estimateLow: low, estimateHigh: high, confidence: result!.confidence },
    } as QuoteInputs & SelfServeMeta;
    const saved = await saveQuote({ address: geo.formattedAddress }, inputsWithMeta, priced, 'holiday');
    quoteId = saved?.id ?? null;
  } catch (err) {
    console.error('[api/estimate] draft save failed (returning price anyway):', err);
  }

  return NextResponse.json(
    { measured: true, quoteId, low, high, formattedAddress: geo.formattedAddress },
    { status: 200 },
  );
}
