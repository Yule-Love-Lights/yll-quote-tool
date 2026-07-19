// Self-serve estimate telemetry (Phase A, slice 2b). Records the range a
// customer was shown at the moment /api/estimate priced their home, into the
// self_serve_estimates table. The dashboard later compares this against the
// linked quote's verified-final total (the Phase A→B accuracy signal).

import { getSupabaseServiceClient } from '@/lib/supabase';

/**
 * Record the shown estimate range for a self-serve quote. Best-effort and
 * non-throwing: the quote itself is already saved, so a telemetry failure (incl.
 * the table not being migrated yet) must never break the customer's estimate.
 */
export async function recordSelfServeEstimate(
  quoteId: string,
  low: number,
  high: number,
  confidence: string,
): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const { error } = await sb.from('self_serve_estimates').insert({
    quote_id: quoteId,
    estimate_low: low,
    estimate_high: high,
    confidence,
  });
  if (error) {
    console.warn('[selfServe] recordSelfServeEstimate failed (table not migrated yet?):', error.message);
  }
}
