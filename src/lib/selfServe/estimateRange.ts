// Pure logic for the customer self-serve estimate (Phase A). Kept out of the
// route handler so the money-facing math is unit-testable without an HTTP or
// Supabase layer.
//
// The self-serve flow reuses the SAME analyzer (photoAnalysis) and the SAME
// pricing engine (calculateQuote) staff use — this module only (a) decides
// whether an analyzer result is confident enough to quote at all, (b) maps that
// result into the holiday engine's QuoteInputs, and (c) turns the engine's
// single total into the RANGE the customer sees. Phase A never shows a binding
// number; staff confirm every self-serve quote before the customer can pay.

import type { QuoteInputs } from '@/lib/pricing/pricingEngine';
import type { PhotoAnalysisResult } from '@/lib/photoAnalysis';

export type EstimateRange = { low: number; high: number };

const RANGE_ROUND_TO = 50;
const DEFAULT_MARGIN = 0.1;

/**
 * Bracket the engine total with a symmetric margin, rounding the low DOWN and
 * the high UP to a clean $50 so the customer sees e.g. "$2,200 – $2,750", not a
 * false-precision "$2,232 – $2,728". A non-positive / non-finite total is a
 * programming error (the holiday engine enforces a $1,000 minimum), so we throw
 * rather than render a garbage "$0 – $0" the customer might anchor on.
 */
export function computeEstimateRange(total: number, marginPct: number = DEFAULT_MARGIN): EstimateRange {
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`computeEstimateRange: total must be a positive finite number, got ${total}`);
  }
  const low = Math.max(0, Math.floor((total * (1 - marginPct)) / RANGE_ROUND_TO) * RANGE_ROUND_TO);
  const high = Math.ceil((total * (1 + marginPct)) / RANGE_ROUND_TO) * RANGE_ROUND_TO;
  return { low, high };
}

/**
 * True when an analyzer result is confident enough to quote a self-serve price.
 * The self-serve flow must never silently quote $0: a null result (analyzer
 * outage), a 'low' confidence, or zero roofline footage on BOTH the street and
 * satellite sources all fall back to the "we'll finish your custom quote and
 * reach out" lead-capture path instead of showing a number.
 */
export function isMeasurable(result: PhotoAnalysisResult | null): boolean {
  if (!result) return false;
  if (result.confidence === 'low') return false;
  const roofline =
    Math.max(result.santasFootage, result.satelliteSantasFootage) +
    Math.max(result.gingerbreadFootage, result.satelliteGingerbreadFootage);
  return roofline > 0;
}

/**
 * Map an analyzer result into the holiday engine's QuoteInputs. Mirrors the
 * minimal footage-only path of QuoteBuilder.applyAnalysisResult: roofline
 * footage + difficulties, everything else zero/empty. When the analyzer chose
 * the satellite source AND it produced footage, that footage wins (deterministic
 * feet-per-pixel), else the street measurement is used.
 */
export function analysisToHolidayInputs(result: PhotoAnalysisResult): QuoteInputs {
  const useSatellite = result.preferredSource === 'satellite';
  const santasFootage =
    useSatellite && result.satelliteSantasFootage > 0
      ? result.satelliteSantasFootage
      : result.santasFootage;
  const gingerbreadFootage =
    useSatellite && result.satelliteGingerbreadFootage > 0
      ? result.satelliteGingerbreadFootage
      : result.gingerbreadFootage;

  return {
    santasFootage,
    santasDifficulty: result.santasDifficulty,
    gingerbreadFootage,
    gingerbreadDifficulty: result.gingerbreadDifficulty,
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'medium',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'medium',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
  };
}
