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
  // list). Otherwise the baseline is what prep ACTUALLY took off the shelf.
  //
  // Row 383 — the KNOWN LIMITATION recorded here on 2026-07-22 is now fixed.
  // It read: "prepareJobMaterials does not persist what it actually deducted,
  // so this baseline is re-derived from the design as it stands NOW ... the
  // true-up is measured against today's projection rather than what really came
  // off the shelf ... anchoring it properly means persisting prep's deductions,
  // which touches the prep path and is tracked separately." Row 325 (PR #926)
  // shipped exactly that: `jobs.stock_deductions`, the per-prep snapshot, which
  // arrives on the work order as `wo.job.stockDeductions`.
  //
  // This is not only an audit improvement, it corrects real stock math. The
  // snapshot records what was DEDUCTED, and computeStockDeductions floors that
  // at available stock (`after = max(0, onHand - qty)`), so a job prepped while
  // short took LESS off the shelf than the projection claims. Concrete case:
  // need 5, on hand 2 -> prep deducts 2. Crew reports 5 used. Against today's
  // live projection the delta is 5-5 = 0 and nothing moves, leaving 3 units
  // never deducted; against the snapshot it is 2-5 = -3 and the missing 3 come
  // off. The old baseline also drifted whenever the design changed between prep
  // and completion (a colour swap, an added strand, a change order).
  //
  // Three states, per row 325's own contract (jobs.ts):
  //   StockDeduction[]        - the accurate snapshot. Use it.
  //   PENDING_STOCK_SNAPSHOT  - prepped by current code, snapshot write never
  //                             landed. Ambiguous, so fall back.
  //   null                    - prepped before the column existed (legacy).
  //                             Fall back.
  // Both fallbacks keep the pre-row-383 behaviour rather than inventing a
  // figure, which is the same posture cancel takes on those two states.
  const prepSnapshot = wo.job.stockDeductions;
  const haveExactBaseline = Array.isArray(prepSnapshot);
  let estimated = haveExactBaseline
    ? prepSnapshot.map((d) => ({ sku: d.sku, qty: d.deducted }))
    : wo.materials.materials.map((m) => ({ sku: m.sku, qty: m.qty }));
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
  // Row 383: an empty EXACT snapshot is trustworthy — it means prep genuinely
  // deducted nothing (every sku untracked, or nothing was in stock). Treating
  // that as "unavailable" would silently skip the true-up on a job whose crew
  // usage really should come off now. The distrust below is aimed at the
  // FALLBACK path, where an empty list is indistinguishable from
  // getJobWorkOrder having swallowed a sub-read to an empty default.
  if (preppedBaseline && !estimated.length && !haveExactBaseline) {
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

  // Which skus we can adjust: the ones inventory_on_hand tracks. A BOM sku
  // carries its onHand on the work order's pre-claim snapshot (buildMaterialsView
  // set it), so the common case needs no extra read — avoiding the redundant
  // post-claim listOnHand() whose transient failure would drop every true-up for
  // an already-burned job. But a reported EXTRA sku the crew grabbed that isn't
  // in this job's BOM (materialResolve's catalog-tier fallback — a routine,
  // designed path) has no snapshot here, and it may well be stocked. Look those
  // up with ONE scoped listOnHand, and only when there actually are extras,
  // rather than silently marking a real stocked item untracked.
  const bomOnHand = new Map(wo.materials.materials.map((m) => [m.sku, m.onHand]));
  const extras = allTrueUps.filter((t) => !bomOnHand.has(t.sku));
  const extraTracked = extras.length
    ? new Set((await listOnHand()).map((r) => r.sku))
    : new Set<string>();
  const isTracked = (sku: string): boolean =>
    bomOnHand.has(sku) ? bomOnHand.get(sku) !== null : extraTracked.has(sku);

  const trueUps: MaterialTrueUp[] = [];
  const skipped: string[] = [];
  for (const t of allTrueUps) {
    if (isTracked(t.sku)) trueUps.push(t);
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
