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
import { adjustOnHandAtomic, toQty } from './onHand';

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

/**
 * Record every submitted line for the audit trail. `raw_text` keeps what the
 * crew literally typed and `estimated_qty` keeps what we compared it against,
 * so a stock movement can be explained months later.
 *
 * A failed insert is logged but never aborts the stock work: the true-up is the
 * thing that matters operationally, and staff can reconcile a missing audit row
 * by hand.
 */
async function insertActualRows(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  jobId: string,
  lines: MaterialActualLine[],
  recordedBy: string,
  estimatedBySku: Map<string, number>,
): Promise<void> {
  if (!lines.length) return;
  const { error } = await db.from('job_material_actuals').insert(
    lines.map((l) => ({
      job_id: jobId,
      sku: l.sku,
      qty: toQty(l.qty),
      estimated_qty: estimatedBySku.get(l.sku) ?? 0,
      raw_text: l.rawText ?? null,
      recorded_by: recordedBy,
    })),
  );
  if (error) console.error('recordMaterialActuals: insert failed:', error);
}

export type RecordActualsResult =
  | { ok: true; alreadyDone: true }
  | {
      ok: true;
      alreadyDone: false;
      trueUps: MaterialTrueUp[];
      skipped: string[];
      /**
       * The actuals were recorded but stock was deliberately NOT adjusted,
       * because the estimate this job was prepped against could not be trusted.
       * See the guard in recordMaterialActuals.
       */
      baselineUnavailable?: true;
    };

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
  const { data: claimed, error: claimErr } = await db
    .from('jobs')
    .update({ materials_actualized_at: new Date().toISOString() })
    .eq('id', jobId)
    .is('materials_actualized_at', null)
    .select('id')
    .maybeSingle();

  // An ERRORED claim and a LOST claim both come back without a row, and they
  // mean opposite things. Treating an error as "already done" is the worst
  // outcome available: the caller tells the crew their materials were already
  // recorded, when in fact nothing was written and no stock moved. That is
  // precisely what happens if this deploys before the migration is applied
  // (materials_actualized_at does not exist yet), so it must fail retryable.
  if (claimErr) {
    console.error('recordMaterialActuals: claim failed:', claimErr);
    return null;
  }
  if (!claimed) return { ok: true, alreadyDone: true };

  // Test Quote safety (ledger #93, mirrors prepareJobMaterials): the rows are
  // still recorded for the audit trail, but a test job must NEVER touch real
  // on-hand — and must not take over prep's claim below either.
  if (wo.job.isTest) {
    await insertActualRows(db, jobId, lines, recordedBy, new Map());
    return { ok: true, alreadyDone: false, trueUps: [], skipped: [] };
  }

  // Baseline: if prep never ran (stockDecrementedAt null), nothing was ever
  // deducted for this job, so every actual is a full deduction (empty estimate
  // list). Otherwise the baseline is the same projected BOM prep used.
  //
  // KNOWN LIMITATION (owner-lens review, 2026-07-22): prepareJobMaterials does
  // not persist what it actually deducted, so this baseline is re-derived from
  // the design as it stands NOW. If the design changed between prep and
  // completion (a colour swap, an added strand, a change order), the true-up is
  // measured against today's projection rather than what really came off the
  // shelf. Recording the baseline on each row below at least makes the
  // comparison auditable after the fact; anchoring it properly means persisting
  // prep's deductions, which touches the prep path and is tracked separately.
  let estimated = wo.materials.materials.map((m) => ({ sku: m.sku, qty: m.qty }));
  // True when the estimate below is the one prep actually deducted against, so
  // an empty list means a bad read rather than "nothing was ever deducted".
  let preppedBaseline = !!wo.job.stockDecrementedAt;

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
    const { data: tookPrepClaim, error: prepClaimErr } = await db
      .from('jobs')
      .update({ stock_decremented_at: new Date().toISOString() })
      .eq('id', jobId)
      .is('stock_decremented_at', null)
      .select('id')
      .maybeSingle();

    // A LOST RACE (zero rows, no error) means prep deducted in between, so we
    // keep the estimate baseline. An ERRORED write also returns zero rows but
    // means the OPPOSITE — stock_decremented_at is still null, so a later Prep
    // will deduct the estimate. Treating an error as a lost race would leave the
    // true-up moving stock in the wrong direction (phantom returns). Can't tell
    // the true state, so record the actuals and DON'T move stock (same safe path
    // as an untrustworthy baseline below).
    if (prepClaimErr) {
      console.error('recordMaterialActuals: prep-claim takeover failed:', prepClaimErr);
      await insertActualRows(db, jobId, lines, recordedBy, new Map());
      return { ok: true, alreadyDone: false, trueUps: [], skipped: [], baselineUnavailable: true };
    }
    if (tookPrepClaim) estimated = [];
    else preppedBaseline = true;
  }

  // An empty baseline on a job that WAS prepped is not trustworthy. getJobWorkOrder
  // swallows each of its sub-reads to an empty default (listCatalog, listOnHand
  // and getInventoryBindings all return [] / {} on error), so a transient glitch
  // produces a non-null work order whose materials list is empty — which is
  // indistinguishable here from a job that genuinely has no bill of materials.
  // Treating it as "estimated 0" would deduct the crew's full actual on top of
  // what prep already took off the shelf: a silent double deduction, the exact
  // failure that makes stock numbers un-trustworthy. Record the submission,
  // leave stock alone, and say so.
  if (preppedBaseline && !estimated.length) {
    await insertActualRows(db, jobId, lines, recordedBy, new Map());
    return { ok: true, alreadyDone: false, trueUps: [], skipped: [], baselineUnavailable: true };
  }

  // Written with the baseline this run actually compared against, so "why did
  // stock move by that much" is answerable later without re-deriving a design
  // that may have changed again since.
  await insertActualRows(
    db,
    jobId,
    lines,
    recordedBy,
    new Map(estimated.map((e) => [e.sku, toQty(e.qty)])),
  );

  // Only true up the skus the crew ACTUALLY reported. An estimated sku the crew
  // didn't mention is left as prep deducted it (delta 0) — NOT returned to the
  // shelf. The actuals are a free-text subset (crew rarely re-list every wire /
  // stake / connector), so treating an un-mentioned estimated sku as "fully
  // unused" would credit its whole install quantity back on every normal
  // close-out, systematically over-stating on-hand. A reported sku that isn't in
  // the estimate (an extra they grabbed) is still handled — it's in `lines`, so
  // computeMaterialTrueUps deducts it.
  const reportedSkus = new Set(lines.map((l) => l.sku));
  const estimatedForReported = estimated.filter((e) => reportedSkus.has(e.sku));
  const allTrueUps = computeMaterialTrueUps(estimatedForReported, lines);

  // Which skus we can adjust: the ones inventory_on_hand tracks. Read from the
  // work order's OWN pre-claim snapshot (buildMaterialsView already set onHand
  // per row) rather than a second listOnHand() after the claim — that redundant
  // read could transiently fail to [] and silently drop every true-up for a job
  // whose claim is already burned. A reported extra sku not in the BOM has no
  // snapshot here, so it's treated as untracked (recorded, not adjusted) — safe.
  const tracked = new Set(
    wo.materials.materials.filter((m) => m.onHand !== null).map((m) => m.sku),
  );
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
