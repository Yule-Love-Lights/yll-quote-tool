// src/lib/inventory/stockMovements.ts
// Row 386: a durable, append-only audit trail of stock taken off / put back on
// the shelf per job. prepareJobMaterials's stock_deductions snapshot (jobs.ts)
// and the cancel route's reversal both live ONLY on the jobs row, and the
// reversal deliberately nulls stock_deductions/stock_decremented_at the moment
// it finishes using them (see the cancel route — that nulling is what lets the
// SAME job be re-prepped later; it must keep happening). That means the record
// of what prep actually deducted and what cancel actually returned is
// destroyed by the very operation whose correctness it exists to make
// answerable after the fact — there is no other durable stock-movement record
// anywhere in the schema. This table is that record: it is never read, never
// updated, and never cleared by prepareJobMaterials or the cancel route —
// both only ever INSERT into it, alongside (not instead of) the existing
// per-job snapshot columns.
//
// Deliberately NOT folded into adjustOnHandAtomic (onHand.ts): that function
// is the shared low-level primitive for EVERY on-hand delta in the app
// (job prep/cancel here, but also supplier receipts in orders.ts and crew
// true-ups in materialActuals.ts) — giving it a job_id/reason parameter would
// change its signature for every caller for a job-scoped audit table that only
// two of them need. Callers that care record a movement explicitly instead.

import { getSupabaseServiceClient } from '../supabase';

export type StockMovementReason = 'prep' | 'cancel_reversal';

export type StockMovementInput = {
  sku: string;
  // Signed: negative = taken off the shelf (prep), positive = returned
  // (cancel reversal) — mirrors adjustOnHandAtomic's own signed `delta`.
  qtyDelta: number;
  before: number;
  after: number;
};

/**
 * Best-effort append to the durable stock_movements audit log — never throws.
 * A failed audit write must not unwind or block the on-hand change it's
 * documenting (mirrors the console.error-and-continue pattern every other
 * on-hand write site in this module already uses for the SKU loop itself).
 * No-ops when there's nothing to record or Supabase isn't configured.
 */
export async function recordStockMovements(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  jobId: string,
  reason: StockMovementReason,
  movements: StockMovementInput[],
): Promise<void> {
  if (!movements.length) return;
  const rows = movements.map((m) => ({
    job_id: jobId,
    sku: m.sku,
    qty_delta: m.qtyDelta,
    before_qty: m.before,
    after_qty: m.after,
    reason,
  }));
  try {
    const { error } = await sb.from('stock_movements').insert(rows);
    if (error) {
      console.error(`recordStockMovements: insert failed for job ${jobId} (${reason}):`, error);
    }
  } catch (err) {
    console.error(`recordStockMovements: insert failed for job ${jobId} (${reason}):`, err);
  }
}
