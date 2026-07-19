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
 * programming error (the caller floors the total at the business minimum before
 * calling this), so we throw rather than render a garbage "$0 – $0" the customer
 * might anchor on. NOTE: this function does NOT apply the $1,000 job minimum —
 * that lives in BUSINESS_RULES.minimumQuoteAmount and is enforced at the portal
 * approval gate, not in calculateQuote's `total`; the route floors accordingly.
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
 * The roofline footage the estimate is priced on, per line. Prefers the source
 * the analyzer chose (satellite when preferredSource==='satellite', else
 * street), but falls back to the other source when the chosen one is 0 — so a
 * house measured on only one source is still priced instead of silently
 * collapsing to $0. isMeasurable and analysisToHolidayInputs BOTH derive from
 * this, so the "is it measurable" gate and the "what footage do we price"
 * mapping can never disagree (a mismatch previously let a satellite-only,
 * street-preferred house pass the gate and then price to $0 → a spurious 503).
 */
function effectiveRooflineFootage(result: PhotoAnalysisResult): { santas: number; gingerbread: number } {
  const useSatellite = result.preferredSource === 'satellite';
  const pick = (street: number, satellite: number): number => {
    const chosen = useSatellite ? satellite : street;
    const other = useSatellite ? street : satellite;
    return chosen > 0 ? chosen : other;
  };
  return {
    santas: pick(result.santasFootage, result.satelliteSantasFootage),
    gingerbread: pick(result.gingerbreadFootage, result.satelliteGingerbreadFootage),
  };
}

/**
 * True when an analyzer result is confident enough to quote a self-serve price.
 * The self-serve flow must never silently quote $0: a null result (analyzer
 * outage), a 'low' confidence, or zero EFFECTIVE roofline footage all fall back
 * to the "we'll finish your custom quote and reach out" lead-capture path
 * instead of showing a number.
 */
export function isMeasurable(result: PhotoAnalysisResult | null): boolean {
  if (!result) return false;
  if (result.confidence === 'low') return false;
  const { santas, gingerbread } = effectiveRooflineFootage(result);
  return santas + gingerbread > 0;
}

/**
 * Map an analyzer result into the holiday engine's QuoteInputs. Mirrors the
 * minimal footage-only path of QuoteBuilder.applyAnalysisResult: roofline
 * footage + difficulties, everything else zero/empty.
 *
 * KNOWN Phase-A limitation: for satellite-preferred homes this uses the
 * analyzer's self-reported satelliteSantasFootage/satelliteGingerbreadFootage,
 * whereas staff price off a DETERMINISTIC recompute (polyline length × feet-per-
 * pixel) done inside QuoteBuilder. That recompute isn't exported, so replicating
 * it here risks drift; the estimate is non-binding and staff verify every quote,
 * and the accuracy telemetry (slice 2b) is designed to MEASURE this exact
 * divergence — extract a shared recompute helper if the data shows it matters.
 */
export function analysisToHolidayInputs(result: PhotoAnalysisResult): QuoteInputs {
  const { santas: santasFootage, gingerbread: gingerbreadFootage } = effectiveRooflineFootage(result);

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
