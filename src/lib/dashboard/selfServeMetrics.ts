// Self-serve estimate accuracy — the dashboard's Phase A→B go/no-go tile
// (ledger self-serve slice 2b). Same split as referralMetrics.ts:
// `computeSelfServeMetrics` is a PURE function over already-fetched rows
// (independently testable, no Supabase); `loadSelfServeMetrics` does the
// batched I/O.
//
// The signal: for each self-serve quote we stored the RANGE the customer was
// shown AND the raw engine total it was built from (self_serve_estimates), and
// we read the current quotes.total live.
//
// CRITICAL — "verified" ≠ "left draft". The shown range is built by bracketing
// the SAME engine total that gets saved as quotes.total, so that saved total is
// ALWAYS inside the range by construction. A quote that is merely sent/declined
// UNCHANGED would therefore count as a trivial in-range hit and inflate the
// metric toward 100% — exactly the number used to decide Phase B. So a row only
// counts as VERIFIED once staff actually re-priced it (its total moved off the
// original estimate total); an unchanged send is not independent evidence and is
// excluded. This biases the accuracy DOWN (conservative), which is the safe
// direction for a go/no-go gate.

import { getSupabaseServiceClient, getSupabaseClient } from '@/lib/supabase';
import { BUSINESS_RULES } from '@/lib/pricing/pricingEngine';

/** One estimate joined to its quote's live total + status. */
export type SelfServeMetricsRow = {
  low: number;
  high: number;
  /** Live quotes.total; null when the quote row is gone or unpriced. */
  total: number | null;
  /** The raw engine total stored at estimate time (self_serve_estimates.estimate_total). */
  estimateTotal: number | null;
  /** Live quotes.status. */
  status: string | null;
};

export type SelfServeMetrics = {
  /** All self-serve estimates generated (test quotes excluded). */
  totalEstimates: number;
  /** Estimates whose quote staff re-priced (an independent verified number). */
  verifiedCount: number;
  /** verified-in-range / verifiedCount. Null when verifiedCount is 0. */
  inRangeRate: number | null;
  /** Median |final − midpoint| / midpoint over verified rows. Null when none. */
  medianMissPct: number | null;
};

const EMPTY_METRICS: SelfServeMetrics = {
  totalEstimates: 0,
  verifiedCount: 0,
  inRangeRate: null,
  medianMissPct: null,
};

function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * A row is VERIFIED evidence only when staff actually produced an independent
 * price: the quote left 'draft' AND its live total moved off the raw engine
 * total we estimated from. A sent/declined-unchanged quote (total ===
 * estimateTotal) is trivially in-range and is NOT counted.
 */
export function isVerified(r: SelfServeMetricsRow): boolean {
  return (
    r.status != null &&
    r.status !== 'draft' &&
    typeof r.total === 'number' &&
    typeof r.estimateTotal === 'number' &&
    r.total !== r.estimateTotal
  );
}

/**
 * Pure compute: in-range accuracy + median miss over the VERIFIED rows. No I/O.
 *
 * `minimum` is the customer-facing job floor (BUSINESS_RULES.minimumQuoteAmount).
 * The shown low is clamped up to it before scoring, so every row scores against the
 * range CURRENT logic would show and the go/no-go tile can't mix eras. The stored low
 * is never rewritten (it still records what that customer was actually shown).
 *
 * The era it guards is real but narrow: telemetry landed 2026-07-19 and the low-floor
 * fix (8a93f386) landed 2026-07-21, and in that two-day window computeEstimateRange's
 * -10% margin re-introduced a sub-minimum low, so a $1,000 home would have stored a
 * $900 low it could never be charged.
 *
 * Measured 2026-08-21: this clamps nothing today. self_serve_estimates has 0 rows and
 * no quote carries inputs.meta.source = 'self_serve_estimate', so no such row was ever
 * written. Kept as a cheap guard, not a repair for known-bad data.
 *
 * It cannot invert the band: BOTH writers floor the total at the minimum before
 * bracketing (pre-fix via Math.max(priced.total, minimum) in the route, post-fix
 * inside customerEstimateRange), so the high is always >= 1.1 * minimum.
 */
export function computeSelfServeMetrics(
  rows: SelfServeMetricsRow[],
  minimum: number = BUSINESS_RULES.minimumQuoteAmount,
): SelfServeMetrics {
  const totalEstimates = rows.length;
  if (totalEstimates === 0) return EMPTY_METRICS;

  const verified = rows.filter(isVerified);
  const verifiedCount = verified.length;
  if (verifiedCount === 0) {
    return { totalEstimates, verifiedCount: 0, inRangeRate: null, medianMissPct: null };
  }

  // Clamp the shown low to the customer-facing floor (see doc above).
  const shownLow = (r: SelfServeMetricsRow) => Math.max(r.low, minimum);
  const inRange = verified.filter((r) => r.total! >= shownLow(r) && r.total! <= r.high).length;
  const misses = verified
    .map((r) => {
      const mid = (shownLow(r) + r.high) / 2;
      return mid > 0 ? Math.abs(r.total! - mid) / mid : 0;
    })
    .sort((a, b) => a - b);

  return {
    totalEstimates,
    verifiedCount,
    inRangeRate: inRange / verifiedCount,
    medianMissPct: median(misses),
  };
}

// PostgREST caps a select at 1000 rows by default; an explicit high ceiling +
// deterministic order keeps totalEstimates honest (and the sample stable) well
// past Phase-A volume. If self-serve ever exceeds this, switch to server-side
// aggregation rather than silently truncating.
const MAX_ESTIMATE_ROWS = 5000;

// Batch size for the quotes .in() lookup — keeps the query string bounded even
// at the MAX_ESTIMATE_ROWS ceiling.
const QUOTE_LOOKUP_CHUNK = 500;

/**
 * Batched read + compute for the dashboard tile. Two round trips: all estimate
 * rows, then one `.in()` for the linked quotes (total + status + is_test for
 * exclusion). BEST-EFFORT: returns EMPTY_METRICS on any error, INCLUDING the
 * self_serve_estimates table not existing yet (so this ships safely before the
 * migration is applied). Server-only.
 */
export async function loadSelfServeMetrics(): Promise<SelfServeMetrics> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return EMPTY_METRICS;

  try {
    const { data, error } = await sb
      .from('self_serve_estimates')
      .select('quote_id, estimate_low, estimate_high, estimate_total')
      .order('created_at', { ascending: false })
      .limit(MAX_ESTIMATE_ROWS);
    if (error) {
      console.warn('loadSelfServeMetrics (table not migrated yet?):', error.message);
      return EMPTY_METRICS;
    }
    const estimates = (data ?? []) as Array<{
      quote_id: string;
      estimate_low: number;
      estimate_high: number;
      estimate_total: number | null;
    }>;
    if (estimates.length === 0) return EMPTY_METRICS;

    const quoteIds = [...new Set(estimates.map((e) => e.quote_id))];
    const quoteById = new Map<string, { total: number | null; status: string | null; isTest: boolean }>();
    // Chunk the .in() lookup so a large id set can't build an oversized query
    // string (PostgREST puts .in() values in the URL). At Phase-A volume this is
    // a single batch; the chunking just keeps it safe past MAX_ESTIMATE_ROWS.
    for (let i = 0; i < quoteIds.length; i += QUOTE_LOOKUP_CHUNK) {
      const batch = quoteIds.slice(i, i + QUOTE_LOOKUP_CHUNK);
      const { data: qrows } = await sb
        .from('quotes')
        .select('id, total, status, is_test')
        .in('id', batch);
      for (const q of (qrows ?? []) as Array<{ id: string; total: number | null; status: string | null; is_test: boolean | null }>) {
        quoteById.set(q.id, { total: q.total, status: q.status, isTest: !!q.is_test });
      }
    }

    const rows: SelfServeMetricsRow[] = [];
    for (const e of estimates) {
      const q = quoteById.get(e.quote_id);
      // Drop estimates whose quote is gone or is a seeded test row (ledger #93).
      if (!q || q.isTest) continue;
      rows.push({
        low: e.estimate_low,
        high: e.estimate_high,
        total: typeof q.total === 'number' ? q.total : null,
        estimateTotal: typeof e.estimate_total === 'number' ? e.estimate_total : null,
        status: q.status,
      });
    }

    return computeSelfServeMetrics(rows);
  } catch (err) {
    console.warn('loadSelfServeMetrics failed:', err);
    return EMPTY_METRICS;
  }
}
