// src/lib/inventory/jobStockMovements.ts
// Row 386 (renamed row 397): a durable, append-only audit trail of stock
// taken off / put back on the shelf per JOB PREP OR JOB-CANCEL REVERSAL
// specifically — it does NOT cover every stock-changing event in the app.
// prepareJobMaterials's stock_deductions snapshot (jobs.ts) and the cancel
// route's reversal both live ONLY on the jobs row, and the reversal
// deliberately nulls stock_deductions/stock_decremented_at the moment it
// finishes using them (see the cancel route — that nulling is what lets the
// SAME job be re-prepped later; it must keep happening). That means the
// record of what prep actually deducted and what cancel actually returned is
// destroyed by the very operation whose correctness it exists to make
// answerable after the fact. This table is that record: it is never read,
// never updated, and never cleared by prepareJobMaterials or the cancel
// route — both only ever INSERT into it, alongside (not instead of) the
// existing per-job snapshot columns.
//
// WHAT THIS DOES NOT COVER (row 397): adjustOnHandAtomic (onHand.ts) is the
// shared low-level primitive for EVERY on-hand delta in the app, but only
// TWO of its callers write here. The other two movement classes were
// deliberately left out because, unlike prep/cancel, they never destroy
// their own record:
//   - supplier receipts (orders.ts, receiveOrder) persist durably in
//     inventory_orders.received_lines + received_at.
//   - crew true-ups (materialActuals.ts, recordMaterialActuals) persist
//     durably in job_material_actuals.
// There is NO single table today that answers "why is on-hand for SKU X what
// it is" across every movement class — that answer requires this table plus
// the two above. Giving adjustOnHandAtomic a job_id/reason parameter to fold
// those two in would change its signature for every caller to serve a
// job-scoped audit table only two of them need — deliberately out of scope
// here. Callers that care record a movement explicitly instead.

import { getSupabaseServiceClient } from '../supabase';

export type JobStockMovementReason = 'prep' | 'cancel_reversal';

export type JobStockMovementInput = {
  sku: string;
  // Signed: negative = taken off the shelf (prep), positive = returned
  // (cancel reversal) — mirrors adjustOnHandAtomic's own signed `delta`.
  qtyDelta: number;
  before: number;
  after: number;
};

/**
 * Best-effort append to the durable job_stock_movements audit log — never
 * throws. A failed audit write must not unwind or block the on-hand change
 * it's documenting (mirrors the console.error-and-continue pattern every
 * other on-hand write site in this module already uses for the SKU loop
 * itself).
 * No-ops when there's nothing to record or Supabase isn't configured.
 */
export async function recordJobStockMovements(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  jobId: string,
  reason: JobStockMovementReason,
  movements: JobStockMovementInput[],
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
    const { error } = await sb.from('job_stock_movements').insert(rows);
    if (error) {
      console.error(`recordJobStockMovements: insert failed for job ${jobId} (${reason}):`, error);
    }
  } catch (err) {
    console.error(`recordJobStockMovements: insert failed for job ${jobId} (${reason}):`, err);
  }
}
