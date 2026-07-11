// Referral auto-analyze (ledger #41 V2) — an optional AI preview shown on the
// /refer/<code> landing page right after a lead submits their address: "see
// your house in lights instantly," no staff, no site visit.
//
// DORMANT by default: gated behind REFERRAL_AUTO_ANALYZE_ENABLED because this
// runs off a PUBLIC, unauthenticated form and every call spends real
// Anthropic + Google Maps money. When the flag is unset/false (the shipped
// default), isReferralAutoAnalyzeEnabled() short-circuits maybeRunReferral-
// AutoAnalyze() to a no-op — the submit route's behavior and response shape
// are unchanged from before this feature existed.
//
// Reuses the SAME holiday analyzer the operator "Analyze" button on
// /api/analyze-address calls (getCachedAddressImagery + runAnalyzeWithFewShot)
// — no reimplementation. The returned line segments are the same LineSegment
// shape src/components/training/AnnotatedPhoto.tsx already knows how to draw
// over a photo, so the landing page reuses that renderer too.
//
// Guards (all required, even with the flag on):
//   (a) a per-IP AND a per-referral-code daily cap (small, default 3/day
//       each) — either tripping skips the analyze. Neither check has a cost
//       side effect on its own (checkRateLimit/checkRateLimitByKey only
//       consume a slot on an OK verdict), so a request blocked by one cap
//       doesn't burn a slot on the other.
//   (b) dedupe — the same code+address pair is never analyzed twice. Marked
//       BEFORE the analyze call (not just on success) so a flaky retry of
//       the same pair can't re-spend either.
//   (c) fail-open — every exit from maybeRunReferralAutoAnalyze is either a
//       preview or null; it never throws, so a failure here can't break lead
//       capture (the route's own try/catch around the call is belt-and-
//       suspenders, matching this file's own internal catch).
//   (d) every skip is logged with its reason, so a silent truncation (cap,
//       dedupe, missing config, no Street View) is visible in the logs.

import type { NextRequest } from 'next/server';
import { checkRateLimit, checkRateLimitByKey } from './rateLimit';
import { isClaudeConfigured } from './claude';
import { isGoogleMapsConfigured, getCachedAddressImagery, NoStreetViewError } from './googleMaps';
import { runAnalyzeWithFewShot } from './analyzeWithFewShot';
import type { LineSegment } from './photoAnalysis';

const LOG_PREFIX = '[referral-auto-analyze]';

export function isReferralAutoAnalyzeEnabled(): boolean {
  return process.env.REFERRAL_AUTO_ANALYZE_ENABLED === 'true';
}

// Cheap pre-filter before spending anything on a request: needs at least one
// digit (a house number), at least one letter, more than one word, and a
// sane minimum length. geocodeAddress() inside getCachedAddressImagery is the
// real validator (it throws on garbage) — this just stops an obviously empty
// or junk value from ever reaching Google/Anthropic.
export function looksLikeRealAddress(address: string): boolean {
  const t = address.trim();
  if (t.length < 8) return false;
  if (!/\d/.test(t)) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  return /\s/.test(t);
}

const DAILY_CAP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeAddressKey(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, ' ');
}

// code+address dedupe store — same Map + expiresAt shape as googleMaps.ts's
// own imagery cache. In-memory, per-process: the same acceptable-guardrail
// tradeoff as rateLimit.ts (bounds cost on a single warm lambda; not a
// substitute for a durable cross-region store).
type DedupeEntry = { expiresAt: number };
const analyzedPairs = new Map<string, DedupeEntry>();

function dedupeKey(code: string, address: string): string {
  return `${code}::${normalizeAddressKey(address)}`;
}

function alreadyAttempted(code: string, address: string): boolean {
  const key = dedupeKey(code, address);
  const entry = analyzedPairs.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    analyzedPairs.delete(key);
    return false;
  }
  return true;
}

function markAttempted(code: string, address: string): void {
  analyzedPairs.set(dedupeKey(code, address), { expiresAt: Date.now() + DAY_MS });
}

/** Test-only: reset in-memory guard state between test cases. Not part of the runtime API. */
export function __resetReferralAutoAnalyzeState(): void {
  analyzedPairs.clear();
}

export type ReferralAutoAnalyzePreview = {
  photoDataUrl: string;
  formattedAddress: string;
  footageEstimate: number;
  lines: LineSegment[];
};

/**
 * Best-effort AI preview for a just-submitted referral lead. Always resolves
 * (never throws): returns the preview payload on success, or null for every
 * skip/failure reason (flag off, bad address, not configured, capped,
 * deduped, no Street View coverage, analyzer failure). Callers should treat
 * null as "show the standard follow-up screen" — never a hard error.
 */
export async function maybeRunReferralAutoAnalyze(
  req: NextRequest,
  code: string,
  address: string,
): Promise<ReferralAutoAnalyzePreview | null> {
  try {
    if (!isReferralAutoAnalyzeEnabled()) return null;
    if (!looksLikeRealAddress(address)) return null;
    if (!isClaudeConfigured() || !isGoogleMapsConfigured()) return null;

    if (alreadyAttempted(code, address)) {
      console.log(`${LOG_PREFIX} skipped — duplicate code+address pair`, { code });
      return null;
    }

    const ipCap = checkRateLimit(req, {
      bucket: 'referral-auto-analyze-ip',
      limit: DAILY_CAP,
      windowMs: DAY_MS,
    });
    if (!ipCap.ok) {
      console.log(`${LOG_PREFIX} skipped — per-IP daily cap reached`, { code });
      return null;
    }
    const codeCap = checkRateLimitByKey(`referral:${code}`, {
      bucket: 'referral-auto-analyze-code',
      limit: DAILY_CAP,
      windowMs: DAY_MS,
    });
    if (!codeCap.ok) {
      console.log(`${LOG_PREFIX} skipped — per-code daily cap reached`, { code });
      return null;
    }

    // Mark BEFORE spending — a failure below must not leave the door open for
    // an immediate retry of the exact same pair.
    markAttempted(code, address);

    const { geo, streetView, satellite, satelliteFeetPerPixel } = await getCachedAddressImagery(address);
    const { result } = await runAnalyzeWithFewShot(
      streetView.base64,
      streetView.mediaType,
      undefined,
      {
        satellite: {
          base64: satellite.base64,
          mediaType: satellite.mediaType,
          feetPerPixel: satelliteFeetPerPixel,
        },
      },
      LOG_PREFIX,
    );
    if (!result) return null;

    // Always the street-photo overlay (santasLines are in street-image
    // normalized coordinates) — this is a marketing preview, not the
    // operator's measurement tool, so the lines drawn always match the one
    // photo shown, regardless of which source (street vs satellite) the
    // analyzer preferred for its own footage math.
    return {
      photoDataUrl: `data:${streetView.mediaType};base64,${streetView.base64}`,
      formattedAddress: geo.formattedAddress,
      footageEstimate: Math.round(result.santasFootage),
      lines: result.santasLines,
    };
  } catch (err) {
    if (err instanceof NoStreetViewError) {
      console.log(`${LOG_PREFIX} skipped — no Street View imagery for this address`, { code });
    } else {
      console.error(`${LOG_PREFIX} failed — falling back to the standard follow-up screen:`, err);
    }
    return null;
  }
}
