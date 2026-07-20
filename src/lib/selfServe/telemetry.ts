// Self-serve estimate telemetry (Phase A, slice 2b). Records the range a
// customer was shown at the moment /api/estimate priced their home, into the
// self_serve_estimates table. The dashboard later compares this against the
// linked quote's verified-final total (the Phase A→B accuracy signal).

import { getSupabaseServiceClient } from '@/lib/supabase';

export type SelfServeEstimateRecord = {
  /** Shown range low/high (floored at the job minimum). */
  low: number;
  high: number;
  /** The RAW engine total the range was built from — the dashboard's "did staff
   *  re-price?" baseline (see selfServeMetrics.isVerified). */
  total: number;
  confidence: string;
};

/**
 * Record the shown estimate range + raw total for a self-serve quote. Best-
 * effort and non-throwing: the quote itself is already saved, so a telemetry
 * failure (incl. the table not being migrated yet) must never break the
 * customer's estimate.
 */
export async function recordSelfServeEstimate(quoteId: string, r: SelfServeEstimateRecord): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const { error } = await sb.from('self_serve_estimates').insert({
    quote_id: quoteId,
    estimate_low: r.low,
    estimate_high: r.high,
    estimate_total: r.total,
    confidence: r.confidence,
  });
  if (error) {
    console.warn('[selfServe] recordSelfServeEstimate failed (table not migrated yet?):', error.message);
  }
}
