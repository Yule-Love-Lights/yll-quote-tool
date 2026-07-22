// src/lib/inventory/materialActuals.ts
// STOCK TRUE-UP from field-reported actuals (text-ops bot Phase 2, ledger #168).
// prepareJobMaterials (jobs.ts) deducts the ESTIMATED BOM at prep time and
// nothing today records what the crew actually used on site. This is that
// function's sibling: the bot (or a staff form) calls recordMaterialActuals
// with what got used, and on-hand is trued up by the DIFFERENCE between the
// estimate and the actual — see computeMaterialTrueUps. Table + the
// materials_actualized_at idempotency claim: migrations/2026-07-22-job-material-actuals.sql.

import { getSupabaseServiceClient } from '../supabase';
import { getJobWorkOrder } from './jobs';
import { listOnHand, adjustOnHandAtomic, toQty } from './onHand';

export type MaterialActualLine = { sku: string; qty: number; rawText?: string | null };
export type MaterialTrueUp = { sku: string; estimated: number; actual: number; delta: number };

/**
 * Pure: given what prep estimated vs what the crew actually used, the SIGNED
 * on-hand adjustment per sku. delta = estimated - actual: positive means the
 * crew used LESS than estimated (unused material comes BACK onto the shelf),
 * negative means they used MORE (more comes OFF stock). A sku on only one side
 * is treated as 0 on the other — actual-only is a full deduction, estimate-only
 * is a full return. Zero-delta rows are omitted; there's nothing to true up.
 */
export function computeMaterialTrueUps(
  estimated: { sku: string; qty: number }[],
  actual: MaterialActualLine[],
): MaterialTrueUp[] {
  const estBySku = new Map<string, number>();
  for (const e of estimated) estBySku.set(e.sku, (estBySku.get(e.sku) ?? 0) + toQty(e.qty));
  const actBySku = new Map<string, number>();
  for (const a of actual) actBySku.set(a.sku, (actBySku.get(a.sku) ?? 0) + toQty(a.qty));

  const skus = new Set([...estBySku.keys(), ...actBySku.keys()]);
  const out: MaterialTrueUp[] = [];
  for (const sku of skus) {
    const estimatedQty = estBySku.get(sku) ?? 0;
    const actualQty = actBySku.get(sku) ?? 0;
    const delta = estimatedQty - actualQty;
    if (delta === 0) continue;
    out.push({ sku, estimated: estimatedQty, actual: actualQty, delta });
  }
  return out;
}

export type RecordActualsResult =
  | { ok: true; alreadyDone: true }
  | { ok: true; alreadyDone: false; trueUps: MaterialTrueUp[]; skipped: string[] };

/**
 * Record what a job's crew actually used and true up on-hand by the difference
 * against the estimated BOM (mirrors prepareJobMaterials' claim + apply shape).
 * Idempotent — `jobs.materials_actualized_at` is the claim, so a retry / double
 * submission applies nothing twice. Returns null when Supabase isn't configured
 * or the job can't be read (never partially applied in that case).
 */
export async function recordMaterialActuals(
  jobId: string,
  lines: MaterialActualLine[],
  recordedBy: string,
): Promise<RecordActualsResult | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  // Read first, claim second (mirrors prepareJobMaterials' #110 W7-008 guard):
  // a transient read failure must stay retryable, never leave the job stamped
  // done with nothing recorded and zero stock applied.
  const wo = await getJobWorkOrder(jobId);
  if (!wo) return null; // missing job or a transient read failure — no claim, retryable

  // Atomic claim — only the caller that flips NULL → now() proceeds. A second
  // "job 142 done" (a retry, a double-tap, two crew members on the same job)
  // finds the stamp already set and applies nothing.
  const { data: claimed } = await db
    .from('jobs')
    .update({ materials_actualized_at: new Date().toISOString() })
    .eq('id', jobId)
    .is('materials_actualized_at', null)
    .select('id')
    .maybeSingle();
  if (!claimed) return { ok: true, alreadyDone: true };

  // Record every submitted line for the audit trail (raw_text keeps what the
  // crew literally typed, for a dispute or a debug session). A failed insert
  // doesn't abort the stock work below — the true-up matters more than the
  // audit row, and staff can reconcile the row manually.
  if (lines.length) {
    const { error: insertErr } = await db.from('job_material_actuals').insert(
      lines.map((l) => ({
        job_id: jobId,
        sku: l.sku,
        qty: toQty(l.qty),
        raw_text: l.rawText ?? null,
        recorded_by: recordedBy,
      })),
    );
    if (insertErr) console.error('recordMaterialActuals: insert failed:', insertErr);
  }

  // Test Quote safety (ledger #93, mirrors prepareJobMaterials): the rows above
  // are recorded for the audit trail, but a test job must NEVER touch real
  // on-hand.
  if (wo.job.isTest) return { ok: true, alreadyDone: false, trueUps: [], skipped: [] };

  // Baseline: if prep never ran (stockDecrementedAt null), nothing was ever
  // deducted for this job, so every actual is a full deduction (empty estimate
  // list). Otherwise the baseline is the same projected BOM prep used.
  let estimated = wo.materials.materials.map((m) => ({ sku: m.sku, qty: m.qty }));

  if (!wo.job.stockDecrementedAt) {
    // Closing out an UNPREPPED job also has to take over prep's claim, or the
    // stock comes off twice: we deduct the full actual here, and a later "Prep"
    // click (stock_decremented_at still null) would deduct the estimate on top.
    // Stamping it makes prepareJobMaterials a no-op for this job.
    //
    // The guarded update doubles as the race check: if prep slipped in between
    // our read above and this write, we get zero rows back — which means the
    // estimate WAS deducted after all, so we keep the estimate baseline instead
    // of treating the job as never-prepped.
    const { data: tookPrepClaim } = await db
      .from('jobs')
      .update({ stock_decremented_at: new Date().toISOString() })
      .eq('id', jobId)
      .is('stock_decremented_at', null)
      .select('id')
      .maybeSingle();
    if (tookPrepClaim) estimated = [];
  }

  const allTrueUps = computeMaterialTrueUps(estimated, lines);

  // Only adjust TRACKED skus (present in inventory_on_hand) — a sku nobody
  // stocks gets no row created (mirrors computeStockDeductions' onHand !== null
  // gate in jobs.ts).
  const onHand = await listOnHand();
  const tracked = new Set(onHand.map((r) => r.sku));
  const trueUps: MaterialTrueUp[] = [];
  const skipped: string[] = [];
  for (const t of allTrueUps) {
    if (tracked.has(t.sku)) trueUps.push(t);
    else skipped.push(t.sku);
  }

  for (const t of trueUps) {
    try {
      // Atomic delta (mirrors prepareJobMaterials' -deducted call) so a
      // true-up can never clobber a concurrent receipt or another job's
      // adjustment on the same SKU.
      await adjustOnHandAtomic(db, t.sku, t.delta);
    } catch (err) {
      // A single failed write shouldn't unwind the rest; staff can reconcile
      // that SKU manually on the Stock tab. Log for visibility.
      console.error(`recordMaterialActuals: on-hand write failed for ${t.sku}:`, err);
    }
  }

  return { ok: true, alreadyDone: false, trueUps, skipped };
}
