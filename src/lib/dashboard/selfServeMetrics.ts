// Self-serve estimate accuracy — the dashboard's Phase A→B go/no-go tile
// (ledger self-serve slice 2b). Same split as referralMetrics.ts:
// `computeSelfServeMetrics` is a PURE function over already-fetched rows
// (independently testable, no Supabase); `loadSelfServeMetrics` does the
// batched I/O.
//
// The signal: for each self-serve quote we stored the RANGE the customer was
// shown (self_serve_estimates), and we read the current quotes.total live. Once
// staff review a quote (it leaves 'draft'), its total is the verified-final —
// so "how often did the verified-final land inside the shown range" is the
// accuracy that decides when Phase A can graduate to Phase B deposits.

import { getSupabaseServiceClient, getSupabaseClient } from '@/lib/supabase';

/** One estimate joined to its quote's live total + status. */
export type SelfServeMetricsRow = {
  low: number;
  high: number;
  /** Live quotes.total; null when the quote row is gone or unpriced. */
  total: number | null;
  /** True once staff have moved the quote past 'draft' (reviewed it). */
  reviewed: boolean;
};

export type SelfServeMetrics = {
  /** All self-serve estimates generated (test quotes excluded). */
  totalEstimates: number;
  /** Estimates whose quote staff have reviewed (left 'draft') AND is priced. */
  reviewedCount: number;
  /** reviewed-in-range / reviewedCount. Null when reviewedCount is 0. */
  inRangeRate: number | null;
  /** Median |final − midpoint| / midpoint over reviewed rows. Null when none. */
  medianMissPct: number | null;
};

const EMPTY_METRICS: SelfServeMetrics = {
  totalEstimates: 0,
  reviewedCount: 0,
  inRangeRate: null,
  medianMissPct: null,
};

function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Pure compute: in-range accuracy + median miss over the reviewed rows. No I/O.
 */
export function computeSelfServeMetrics(rows: SelfServeMetricsRow[]): SelfServeMetrics {
  const totalEstimates = rows.length;
  if (totalEstimates === 0) return EMPTY_METRICS;

  const reviewed = rows.filter((r) => r.reviewed && typeof r.total === 'number');
  const reviewedCount = reviewed.length;
  if (reviewedCount === 0) {
    return { totalEstimates, reviewedCount: 0, inRangeRate: null, medianMissPct: null };
  }

  const inRange = reviewed.filter((r) => r.total! >= r.low && r.total! <= r.high).length;
  const misses = reviewed
    .map((r) => {
      const mid = (r.low + r.high) / 2;
      return mid > 0 ? Math.abs(r.total! - mid) / mid : 0;
    })
    .sort((a, b) => a - b);

  return {
    totalEstimates,
    reviewedCount,
    inRangeRate: inRange / reviewedCount,
    medianMissPct: median(misses),
  };
}

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
      .select('quote_id, estimate_low, estimate_high');
    if (error) {
      console.warn('loadSelfServeMetrics (table not migrated yet?):', error.message);
      return EMPTY_METRICS;
    }
    const estimates = (data ?? []) as Array<{ quote_id: string; estimate_low: number; estimate_high: number }>;
    if (estimates.length === 0) return EMPTY_METRICS;

    const quoteIds = [...new Set(estimates.map((e) => e.quote_id))];
    const quoteById = new Map<string, { total: number | null; status: string | null; isTest: boolean }>();
    const { data: qrows } = await sb
      .from('quotes')
      .select('id, total, status, is_test')
      .in('id', quoteIds);
    for (const q of (qrows ?? []) as Array<{ id: string; total: number | null; status: string | null; is_test: boolean | null }>) {
      quoteById.set(q.id, { total: q.total, status: q.status, isTest: !!q.is_test });
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
        reviewed: q.status != null && q.status !== 'draft',
      });
    }

    return computeSelfServeMetrics(rows);
  } catch (err) {
    console.warn('loadSelfServeMetrics failed:', err);
    return EMPTY_METRICS;
  }
}
