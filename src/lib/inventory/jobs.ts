// src/lib/inventory/jobs.ts
// FULFILLMENT side of the SHARED `jobs` table (#82 Slice 3). The billing side
// (src/lib/jobs.ts) is the SINGLE creator — a job is auto-created on the
// deposit-paid Valor webhook. This module reads those same rows for the materials
// / fulfillment Kanban and updates ONLY `fulfillment_stage`; it never inserts a
// job. See the unified migration 2026-06-27-jobs.sql + design spec §8 (Slice 3).

import { getSupabaseServiceClient } from '../supabase';
import { listJobs, getJob, type JobRow } from '../jobs';
import type { JobStatus } from '../jobStatus';
import type { Scene } from '@/lib/design/sceneTypes';
import type { QuoteResult, QuoteInputs } from '@/lib/pricing/pricingEngine';
import { getInventoryBindings, type Bindings, type ClipRules } from './bindings';
import { listCatalog, catalogCostOverrides } from './catalog';
import { listOnHand, adjustOnHandAtomic } from './onHand';
import { recordJobStockMovements } from './jobStockMovements';
import { projectMaterials, buildMaterialsView, type MaterialLine, type MaterialsView } from './materialsProjection';
import { colorChoiceFromSnapshot } from './resolveInstalls';
import { permanentBomFromQuote, includedPermanentSidesFromSnapshot } from '@/lib/permanent/bomFromQuote';
import { ALL_PERMANENT_SIDES, type PermanentQuoteFields, type PermanentSide } from '@/lib/permanent/types';
import { bistroBomFromQuote } from '@/lib/permanentBistro/bomFromQuote';
import type { PermanentBistroInputFields } from '@/lib/permanentBistro/types';
import { BISTRO_CATALOG, costOverridesFromBistroCatalog } from './bistroCatalog';
import { buildPortalLineItems } from '@/lib/portal/adapter';
import { attachSceneLinks } from '@/lib/portal/sceneLinks';
import {
  fulfillmentStageOf,
  FULFILLMENT_STAGES,
  type FulfillmentStage,
} from './fulfillmentStage';

// A job is in the active FULFILLMENT window between deposit-paid (billing
// 'to_schedule') and install ('installed'+): that's when materials get ordered,
// picked up, prepped, and staged. Once installed the materials are consumed and
// the job leaves the board; 'cancelled' is off entirely.
export function isActiveFulfillment(status: string): boolean {
  return status === 'to_schedule' || status === 'scheduled';
}

// One board card — the billing JobRow distilled, plus its resolved fulfillment
// stage and the linked quote's customer identity (the job's own customer_id stays
// null until #83 Phase 5).
export type FulfillmentCard = {
  id: string;
  jobNumber: number | null;
  quoteId: string | null;
  designId: string | null;
  stage: FulfillmentStage;
  status: JobStatus;
  customerName: string | null;
  customerAddress: string | null;
  itemCount: number;
  installDate: string | null;
  // Test Quote (ledger #93): VISIBLE in the Kanban but badged TEST + inert on
  // real stock (prepareJobMaterials no-ops the deduction). Derived via the quote.
  isTest: boolean;
  // Customer detail-page route id fields (same precedence as QuoteListItem /
  // src/lib/dashboard/customers.ts customerRouteId: highlevel_contact_id, else
  // customer_id) — lets the board link a customer name to their profile.
  // customerId prefers the job's OWN customer_id over the linked quote's,
  // mirroring JobAdminCard's precedence (same jobs table).
  highlevelContactId: string | null;
  customerId: string | null;
  // Row 382: true when this job's stock_deductions is stuck at
  // PENDING_STOCK_SNAPSHOT — prepped by current code, but the accurate
  // follow-up snapshot write never landed (a transient failure right after
  // prep). The job has already advanced to 'ready_for_install' by the time
  // this can happen (the claim stamps both in the same write), which is
  // BEFORE the prep-stages digest below — so without this flag, nothing
  // enumerates these jobs and the state is only ever discovered by opening
  // (or cancelling) that specific job. See PENDING_STOCK_SNAPSHOT in jobs.ts.
  stockSnapshotPending: boolean;
};

// Pure: bucket cards into the four columns (every column present, stable order).
export function groupByStage(cards: FulfillmentCard[]): Record<FulfillmentStage, FulfillmentCard[]> {
  const out = Object.fromEntries(
    FULFILLMENT_STAGES.map((s) => [s, [] as FulfillmentCard[]]),
  ) as Record<FulfillmentStage, FulfillmentCard[]>;
  for (const c of cards) out[c.stage].push(c);
  return out;
}

function toCard(
  j: JobRow,
  cust?: { name: string | null; address: string | null; isTest?: boolean; highlevelContactId?: string | null; customerId?: string | null },
  stockSnapshotPending = false,
): FulfillmentCard {
  return {
    id: j.id,
    jobNumber: j.job_number,
    quoteId: j.quote_id,
    designId: j.design_id,
    stage: fulfillmentStageOf(j.fulfillment_stage),
    status: j.status,
    customerName: cust?.name ?? null,
    customerAddress: cust?.address ?? null,
    itemCount: Array.isArray(j.line_items) ? j.line_items.length : 0,
    installDate: j.install_date,
    isTest: cust?.isTest ?? false,
    highlevelContactId: cust?.highlevelContactId ?? null,
    customerId: j.customer_id ?? cust?.customerId ?? null,
    stockSnapshotPending,
  };
}

/**
 * The active-fulfillment jobs as board cards, newest first, with each linked
 * quote's customer name + address joined on (the job's own customer_id is null
 * pre-Phase-5). Returns [] when Supabase isn't configured.
 */
export async function listFulfillmentCards(): Promise<FulfillmentCard[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const jobs = (await listJobs()).filter((j) => isActiveFulfillment(j.status));
  if (!jobs.length) return [];

  const quoteIds = [...new Set(jobs.map((j) => j.quote_id).filter((x): x is string => !!x))];
  const custById = new Map<
    string,
    { name: string | null; address: string | null; isTest: boolean; highlevelContactId: string | null; customerId: string | null }
  >();
  if (quoteIds.length) {
    const { data } = await db
      .from('quotes')
      .select('id, customer_name, customer_address, is_test, highlevel_contact_id, customer_id')
      .in('id', quoteIds);
    for (const q of (data ?? []) as {
      id: string;
      customer_name: string | null;
      customer_address: string | null;
      is_test: boolean | null;
      highlevel_contact_id: string | null;
      customer_id: string | null;
    }[]) {
      custById.set(q.id, {
        name: q.customer_name ?? null,
        address: q.customer_address ?? null,
        isTest: !!q.is_test,
        highlevelContactId: q.highlevel_contact_id ?? null,
        customerId: q.customer_id ?? null,
      });
    }
  }

  // Row 382: a SEPARATE targeted query for stock_deductions rather than
  // widening the shared billing JOB_SELECT (src/lib/jobs.ts) — this column is
  // read-only here and #82-owned, and this file already makes a second query
  // (quotes, above) for the same reason. Only need the sentinel comparison, so
  // this stays a single flat select scoped to the jobs already on the board.
  const jobIds = jobs.map((j) => j.id);
  const pendingById = new Set<string>();
  const { data: sdRows } = await db.from('jobs').select('id, stock_deductions').in('id', jobIds);
  for (const row of (sdRows ?? []) as { id: string; stock_deductions: unknown }[]) {
    if (row.stock_deductions === PENDING_STOCK_SNAPSHOT) pendingById.add(row.id);
  }

  return jobs.map((j) => toCard(j, j.quote_id ? custById.get(j.quote_id) : undefined, pendingById.has(j.id)));
}

/** Set a job's fulfillment stage (the only column #82 writes). Returns ok. */
export async function setJobFulfillmentStage(id: string, stage: FulfillmentStage): Promise<boolean> {
  const db = getSupabaseServiceClient();
  if (!db) return false;
  const { error } = await db.from('jobs').update({ fulfillment_stage: stage }).eq('id', id);
  if (error) {
    console.error('setJobFulfillmentStage error:', error);
    return false;
  }
  return true;
}

// The staff work order for one job: its summary + the projected materials list
// (the design → SKUs via Slice 2a/2d, joined to on-hand). Shared by the job
// detail API and the printable work-order page. Returns null when the job is
// missing or Supabase isn't configured.
export type WorkOrderJob = {
  id: string;
  jobNumber: number | null;
  quoteId: string | null;
  designId: string | null;
  stage: FulfillmentStage;
  status: JobStatus;
  installDate: string | null;
  customerName: string | null;
  customerAddress: string | null;
  stockDecrementedAt: string | null; // #82 Phase 2 — set once prep deducts stock
  // Row 325 (fix round 2, Finding 1): the exact deductions prepareJobMaterials
  // took off on-hand, so the cancel route can reverse the SAME numbers
  // instead of recomputing the materials projection live. Three states:
  //  - null            → never prepped, OR prepped before this snapshot
  //                      column existed at all (true legacy — cancel falls
  //                      back to a live reconstruction and says so).
  //  - PENDING_STOCK_SNAPSHOT ('pending') → prepped by CURRENT code (the
  //                      claim stamps this atomically), but the accurate
  //                      follow-up snapshot write never landed — a transient
  //                      failure. Cancel does NOT reconstruct for this state
  //                      (unlike true legacy): it refuses to auto-reverse and
  //                      asks a human to reconcile, because a live recompute
  //                      here would silently repeat the exact bug this
  //                      snapshot exists to prevent.
  //  - StockDeduction[] → the real, durable snapshot; cancel reverses it
  //                      exactly, empty array included (nothing tracked).
  stockDeductions: StockDeduction[] | typeof PENDING_STOCK_SNAPSHOT | null;
  // Test Quote (ledger #93): derived from the linked quote. Drives the TEST
  // badge + makes prepareJobMaterials no-op the real on-hand deduction.
  isTest: boolean;
};
export type WorkOrder = {
  job: WorkOrderJob;
  materials: MaterialsView;
  /**
   * #192 review fix (parity) — the permanent sides this work order's materials
   * were narrowed to, in front/left/right/back order; null when NOT scoped
   * (a non-permanent job, or a permanent job whose scoping resolved unscoped —
   * see includedPermanentSidesFromSnapshot's fail-open contract). Every
   * consumer of getJobWorkOrder (the board modal, the crew print sheet, the
   * purchasing email) renders a "Booked scope: …" note when this is non-null,
   * so a narrowed materials list is never silently narrower than expected.
   */
  scopedSides: PermanentSide[] | null;
};

// P8 PR-2: map a permanent BOM's lines onto the shared MaterialLine shape so a
// permanent job's work order / prep-deduction reuse buildMaterialsView exactly
// like a holiday job. Every BOM line already carries a real SKU + qty > 0 (see
// bom.ts's `push`), so conceptKey/label are never surfaced (no unbound lines);
// `category` has no holiday-taxonomy equivalent for an Ascend/Dauer part (the
// existing MaterialCategory union is wreath/garland/spritzer/mini/bulb/clip/wire)
// so 'mini' is a neutral placeholder — buildMaterialsView/aggregateMaterials
// never branch on it. `sceneItemId` has no BOM equivalent either.
function materialLinesFromBom(lines: { sku: string; qty: number }[]): MaterialLine[] {
  return lines.map((l): MaterialLine => ({
    sku: l.sku,
    qty: l.qty,
    category: 'mini',
    conceptKey: l.sku,
    label: l.sku,
    sceneItemId: '',
  }));
}

// #117: a bistro job's work order the same way — but BistroBomLine's shape
// differs from BomLine (supplier/url/asNeeded instead of category), so this is
// a sibling helper, not a reuse of materialLinesFromBom. The as-needed
// zip-wire row (qty 0 by definition — Naldo: "no way for you to calculate
// this") has nothing to pick/prep, so it's excluded here; the order sheet
// still lists it via bistroBomFromQuote directly.
function materialLinesFromBistroBom(lines: { sku: string; qty: number; asNeeded?: boolean }[]): MaterialLine[] {
  return lines
    .filter((l) => !l.asNeeded)
    .map((l): MaterialLine => ({
      sku: l.sku,
      qty: l.qty,
      category: 'mini',
      conceptKey: l.sku,
      label: l.sku,
      sceneItemId: '',
    }));
}

// #160: the BOM/materials-view scene item ids to KEEP for a holiday/event job,
// derived from the customer's APPROVED selection (approval_snapshot.customer-
// Selection.selectedItemIds — PortalLineItem ids) instead of the full scene. A
// partial-selection job (e.g. a spritzer priced-but-not-selected before paying)
// must not order materials for items the customer never bought.
//
// Returns null — "keep everything", today's unfiltered behavior — whenever the
// selection can't be confidently resolved: no snapshot / no customerSelection, an
// empty or unparseable selectedItemIds, no saved pricing `result` to rebuild the
// portal line items from, or a selection that (after dropping unknown/stale ids)
// resolves to nothing real. This never regresses an existing/legacy job to an
// empty materials list.
//
// FAIL-OPEN past the top-level null too: a scene item is excluded ONLY when we
// can positively identify the (real, scene-linked) line item backing it AND that
// line item was not selected. Any scene item whose backing line item can't be
// pinned down — attachSceneLinks' per-category count-mismatch guard skipped its
// category (design edited after the last Calculate), or its kind isn't one
// sceneLinks classifies at all — stays in the KEPT set by default. Money-
// adjacent: under-ordering a real job (a silently missing material) is worse
// than a redundant pull-list line for an item that was actually deselected.
//
// Mutually-exclusive roofline (Santa's / Gingerbread): NOT special-cased here —
// it falls out of attachSceneLinks' own sceneItemIds for the pair (Santa's is a
// SUBSET of Gingerbread's — see sceneLinks.ts), so selecting either one alone
// naturally keeps exactly its own scene items and no more. Deliberately NOT filtered
// through billableLineItemIds (the "as sent" single-recommended-option view) —
// the customer can approve EITHER roofline option via the portal toggle (mirrors
// the approve route's own `realIds = all lineItems`, not the billable subset), so
// gating on billable-only would wrongly exclude a real customer's non-default
// roofline pick.
export function selectedSceneItemIds(
  scene: Scene,
  result: QuoteResult | null,
  inputs: QuoteInputs | null,
  approvalSnapshot: unknown,
): Set<string> | null {
  const sel = (approvalSnapshot as { customerSelection?: { selectedItemIds?: unknown } } | null | undefined)
    ?.customerSelection;
  const rawSelectedIds = Array.isArray(sel?.selectedItemIds) ? sel.selectedItemIds : null;
  const selectedItemIds = rawSelectedIds?.filter((x): x is string => typeof x === 'string') ?? null;
  if (!selectedItemIds || selectedItemIds.length === 0) return null; // no / empty selection
  if (!result) return null; // no saved pricing result → can't rebuild the portal line items

  const { lineItems } = buildPortalLineItems(result, inputs);
  // Mirrors the approve route's own tamper-guard (realIds = every line item id,
  // not just the billable/recommended subset) — drops unknown/stale ids only.
  const realIds = new Set(lineItems.map((li) => li.id));
  const selectedIds = new Set(selectedItemIds.filter((lid) => realIds.has(lid)));
  if (selectedIds.size === 0) return null; // selection didn't resolve to any real line item

  const linked = attachSceneLinks(lineItems, scene);
  const linkedSceneItemIds = new Set<string>(); // every scene item claimed by SOME linked line
  const selectedSceneIds = new Set<string>(); // scene items claimed by a SELECTED, linked line
  for (const li of linked) {
    const ids = li.sceneItemIds;
    if (!ids || ids.length === 0) continue; // unlinked → doesn't inform inclusion/exclusion
    for (const sceneId of ids) {
      linkedSceneItemIds.add(sceneId);
      if (selectedIds.has(li.id)) selectedSceneIds.add(sceneId);
    }
  }

  const keep = new Set<string>();
  for (const item of scene.items ?? []) {
    if (selectedSceneIds.has(item.id) || !linkedSceneItemIds.has(item.id)) keep.add(item.id);
  }
  return keep;
}

// #160: like projectMaterials, but narrowed to selectedSceneItemIds above — the
// ONLY call site for the filter, so a permanent/bistro job (its own BOM engine,
// no scene projection at all) never even computes it.
function holidayMaterialLines(
  scene: Scene,
  bindings: Bindings,
  clipRules: ClipRules,
  colorChoice: string[] | null,
  result: QuoteResult | null,
  inputs: QuoteInputs | null,
  approvalSnapshot: unknown,
): MaterialLine[] {
  const lines = projectMaterials(scene, bindings, clipRules, colorChoice);
  const keep = selectedSceneItemIds(scene, result, inputs, approvalSnapshot);
  return keep === null ? lines : lines.filter((l) => keep.has(l.sceneItemId));
}

export async function getJobWorkOrder(id: string): Promise<WorkOrder | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const job = await getJob(id);
  if (!job) return null;

  // The #82 stock-prep flag lives outside the billing JobRow — read it directly.
  // Row 325: stock_deductions rides along in the SAME read — the per-job
  // snapshot of exactly what prepareJobMaterials deducted (see that function),
  // so the cancel route can reverse the real deduction instead of recomputing
  // the materials projection live. Null for a job that was never prepped, OR
  // for a job prepped BEFORE this column existed (see the cancel route's
  // fallback for that legacy case).
  const { data: sd } = await db
    .from('jobs')
    .select('stock_decremented_at, stock_deductions')
    .eq('id', id)
    .maybeSingle();
  const sdRow = sd as {
    stock_decremented_at: string | null;
    stock_deductions: StockDeduction[] | typeof PENDING_STOCK_SNAPSHOT | null;
  } | null;
  const stockDecrementedAt = sdRow?.stock_decremented_at ?? null;
  const stockDeductions = sdRow?.stock_deductions ?? null;

  // Materials from the job's linked design (by quote_id), mirroring the 2d view.
  let scene: Scene = { yardsticks: [], items: [] };
  let customerName: string | null = null;
  let customerAddress: string | null = null;
  let isTest = false;
  let isPermanent = false;
  let isPermanentBistro = false;
  let permanentFields: PermanentQuoteFields | undefined;
  let bistroFields: PermanentBistroInputFields | undefined;
  let colorChoice: string[] | null = null; // #92 — the customer's approved color pick
  // #160 — carried through so a holiday/event job can narrow its materials to the
  // customer's APPROVED selection (see selectedSceneItemIds). Unused by the
  // permanent/bistro branches (their own BOM engines never touch the scene).
  let quoteResult: QuoteResult | null = null;
  let quoteInputs: QuoteInputs | null = null;
  let approvalSnapshotRaw: unknown = null;
  if (job.quote_id) {
    const [{ data: design }, { data: quote }] = await Promise.all([
      db.from('designs').select('scene').eq('quote_id', job.quote_id).maybeSingle(),
      db
        .from('quotes')
        .select('customer_name, customer_address, is_test, approval_snapshot, service_type, inputs, result')
        .eq('id', job.quote_id)
        .maybeSingle(),
    ]);
    if (design?.scene) scene = design.scene as Scene;
    if (quote) {
      const q = quote as {
        customer_name: string | null;
        customer_address: string | null;
        is_test: boolean | null;
        approval_snapshot: unknown;
        service_type: string | null;
        inputs: QuoteInputs | null;
        result: QuoteResult | null;
      };
      customerName = q.customer_name ?? null;
      customerAddress = q.customer_address ?? null;
      isTest = !!q.is_test;
      isPermanent = q.service_type === 'permanent';
      isPermanentBistro = q.service_type === 'permanent_bistro';
      permanentFields = q.inputs?.permanent;
      bistroFields = q.inputs?.permanentBistro;
      colorChoice = colorChoiceFromSnapshot(q.approval_snapshot);
      quoteResult = q.result ?? null;
      quoteInputs = q.inputs ?? null;
      approvalSnapshotRaw = q.approval_snapshot ?? null;
    }
  }

  // #110 W7-009: pass clipRules through (see purchaseOrder.ts) so the job work
  // order / print sheet / order email / prep stock-deduction include clips too.
  const { bindings, clipRules } = await getInventoryBindings();
  // Permanent (P8 PR-2): materials come from the Ascend/Dauer BOM engine, NEVER
  // the scene projection — a permanent job's design scene (if any) must not
  // feed holiday materials. Positive `=== 'permanent'` gate; holiday/event jobs
  // keep the scene-projection path exactly as before.
  // Permanent Bistro (#117): same principle, its own BOM engine — a bistro
  // job's design scene (if any) must not feed holiday materials either.
  // Positive `=== 'permanent_bistro'` gate, checked AFTER permanent (the two
  // service types are mutually exclusive, so order doesn't matter functionally,
  // but this reads as the natural "which BOM engine" ladder).
  // #192 — a job exists only post-booking (deposit paid, see this file's own
  // header), so its materials are ALWAYS scoped to the customer's approved
  // sides. includedPermanentSidesFromSnapshot fails open to null (unscoped —
  // today's full-BOM behavior) on any missing/unparseable/no-match snapshot,
  // so a paid job can never silently under-order. Resolved ONCE so the BOM
  // build and the returned `scopedSides` (review-fix parity — every consumer
  // of this work order gets to render the same "Booked scope" note) agree.
  const includedPermanentSides = isPermanent ? includedPermanentSidesFromSnapshot(approvalSnapshotRaw) : null;
  const lines = isPermanent
    ? materialLinesFromBom(
        permanentBomFromQuote(
          { permanent: permanentFields },
          await catalogCostOverrides(),
          includedPermanentSides,
        )?.lines ?? [],
      )
    : isPermanentBistro
      ? materialLinesFromBistroBom(
          bistroBomFromQuote(
            { permanentBistro: bistroFields },
            costOverridesFromBistroCatalog(await listCatalog()),
          )?.lines ?? [],
        )
      : holidayMaterialLines(scene, bindings, clipRules, colorChoice, quoteResult, quoteInputs, approvalSnapshotRaw);
  const [catalog, onHand] = await Promise.all([listCatalog(), listOnHand()]);
  const nameOf = new Map(catalog.map((c) => [c.sku, c.name]));
  // #117: bistro's SKUs live in the STATIC bistro catalog (no inventory_catalog
  // rows exist for them), so backfill their display names; a DB row with the
  // same SKU still wins above.
  if (isPermanentBistro) {
    for (const item of BISTRO_CATALOG) {
      if (!nameOf.has(item.sku)) nameOf.set(item.sku, item.name);
    }
  }
  const onHandOf = new Map(onHand.map((r) => [r.sku, r.on_hand_qty]));
  const materials = buildMaterialsView(
    lines,
    (sku) => nameOf.get(sku),
    (sku) => (onHandOf.has(sku) ? (onHandOf.get(sku) as number) : null),
  );
  // #192 review fix — the raw included sides, canonical front/left/right/back
  // order, for every getJobWorkOrder consumer to render its own "Booked scope"
  // note. Stays null for a non-permanent job (never computed above) or a
  // permanent job whose scoping resolved unscoped.
  const scopedSides = includedPermanentSides
    ? ALL_PERMANENT_SIDES.filter((s) => includedPermanentSides.has(s))
    : null;

  return {
    job: {
      id: job.id,
      jobNumber: job.job_number,
      quoteId: job.quote_id,
      designId: job.design_id,
      stage: fulfillmentStageOf(job.fulfillment_stage),
      status: job.status,
      installDate: job.install_date,
      customerName,
      customerAddress,
      stockDecrementedAt,
      stockDeductions,
      isTest,
    },
    materials,
    scopedSides,
  };
}

// ── Phase 2: stock loop (decrement on prep) ──────────────────────────────────

export type StockDeduction = { sku: string; before: number; deducted: number; after: number };

// Row 325 fix-round Finding 1: `stock_deductions` is written in TWO steps (the
// atomic claim, then a separate follow-up snapshot write — see
// prepareJobMaterials below for why). If the follow-up ever fails, a `null`
// column was indistinguishable from a genuine pre-Row-325 LEGACY job (never
// snapshotted at all, prepped before this column existed) — and cancel's
// legacy branch would silently reconstruct the reversal from a LIVE materials
// recompute, the exact over/under-credit bug Row 325 exists to prevent, now
// reachable through an ordinary transient write failure instead of a race.
// This sentinel closes the ambiguity: the claim stamps it atomically WITH
// stock_decremented_at, so `null` can only mean "prepped by code that
// predates this column" and this sentinel means "prepped by current code, but
// the accurate snapshot never landed." See WorkOrderJob.stockDeductions below
// and the cancel route for how each of the three states is handled.
export const PENDING_STOCK_SNAPSHOT = 'pending' as const;

// Pure: given the job's aggregated materials (with their current on-hand), what
// comes off stock when prepped. Only TRACKED skus (onHand !== null) with a real
// need are deducted; on-hand floors at 0 (never negative).
export function computeStockDeductions(
  materials: { sku: string; qty: number; onHand: number | null }[],
): StockDeduction[] {
  const out: StockDeduction[] = [];
  for (const m of materials) {
    if (m.onHand === null || m.qty <= 0) continue;
    const after = Math.max(0, m.onHand - m.qty);
    if (after !== m.onHand) out.push({ sku: m.sku, before: m.onHand, deducted: m.onHand - after, after });
  }
  return out;
}

export type PrepareResult =
  | { ok: true; alreadyDone: true }
  // Finding 2 (fix round 2): `short` lists the SKUs whose deducted amount is
  // LESS than what the job actually needed (the on-hand floor-at-0 clamp bit
  // — see the deduction loop below), so a clamped prep — which looks
  // identical to a full one in a bare SKU count — isn't silent. Empty when
  // nothing was short.
  | { ok: true; alreadyDone: false; deductions: StockDeduction[]; short: string[] }
  // Row 329 fix: the atomic CLAIM update itself failed (a real DB error, not
  // just "someone else already claimed it" — see prepareJobMaterials below).
  // Nothing was deducted and the job was not marked prepped; safe to retry.
  | { ok: false; error: string };

/**
 * Mark a job prepped and decrement its on-hand stock — idempotent (Naldo Q4:
 * stock decremented only at prep, once). Atomically CLAIMS the job by stamping
 * stock_decremented_at WHERE it's still NULL (so a double-click / retry can't
 * double-deduct), then advances it to Ready For Install and deducts each tracked
 * SKU's on-hand by the projected need. Returns alreadyDone when the job was
 * already prepped; null if Supabase isn't configured or the job is missing.
 */
export async function prepareJobMaterials(id: string): Promise<PrepareResult | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;

  // #110 W7-008: read + project the materials BEFORE claiming. Previously the
  // claim (stock_decremented_at + stage) was stamped FIRST; getJobWorkOrder's
  // reads swallow errors to empty (getJob→null, bindings→{}, onHand→[]), so a
  // transient read failure left the job permanently marked prepped with ZERO
  // stock deducted, and every retry returned alreadyDone. Reading first means a
  // failed read (wo===null) returns without ever stamping a phantom claim, so
  // the operator can safely retry. The atomic claim below still guards against
  // double-deduction on concurrent prep clicks.
  const wo = await getJobWorkOrder(id);
  if (!wo) return null; // missing job or a transient read failure — no claim, retryable

  // Won the claim → deduct on-hand for the job's tracked materials.
  // Test Quote safety (ledger #93): a test job advances through prep + the Kanban
  // exactly like a real one (the claim below marks it prepped + advances the
  // stage), but it must NEVER touch real on-hand. Skip the deduction entirely
  // — an empty result, so the UI shows "prepped" with no phantom stock change.
  //
  // Row 325 / Row 329: `intendedDeductions` is a PRE-claim read (pure — reads
  // only wo.materials, no DB write) and is used only to pick which SKUs/qtys to
  // attempt below. It is NOT what gets persisted as the durable snapshot —
  // adjustOnHandAtomic floors at 0, so if a concurrent prep/receipt shifts a
  // SKU's on-hand between this read and the deduction loop below, the amount
  // ACTUALLY applied can be smaller (in magnitude) than intended. Persisting
  // the intended numbers let cancel's reversal over-credit on-hand — the exact
  // Row 329 bug. The real snapshot (`actualDeductions`, from adjustOnHandAtomic's
  // own before/after/applied) is written in a SEPARATE update right after the
  // loop, below.
  const intendedDeductions = !wo.job.isTest ? computeStockDeductions(wo.materials.materials) : [];

  // Atomic claim — only the caller that flips NULL → now() proceeds to deduct.
  // Row 329: `error` is now checked explicitly. `.is('stock_decremented_at',
  // null)` matching zero rows (claimed === null, error === null) means someone
  // else already prepped this job (or it vanished) — that's the legitimate
  // alreadyDone case below. A non-null `error` means the UPDATE itself failed
  // (network/DB fault) — previously that was silently treated exactly like
  // alreadyDone, reporting success for a claim that never happened and never
  // deducted anything. Nothing was written in either failure branch here (a
  // failed WHERE-guarded UPDATE writes nothing), so both are safely retryable.
  // Finding 1 (fix round 2): stamp PENDING_STOCK_SNAPSHOT here, in the SAME
  // atomic write as the claim, so `stock_deductions` is never ambiguously
  // null for a job this code claimed — null is reserved for jobs claimed by
  // code that predates this column entirely. The real snapshot overwrites
  // this in the follow-up write below; if that write never lands, the
  // sentinel itself is the durable signal that a human needs to reconcile
  // (see the cancel route).
  const { data: claimed, error: claimError } = await db
    .from('jobs')
    .update({
      stock_decremented_at: new Date().toISOString(),
      fulfillment_stage: 'ready_for_install',
      stock_deductions: PENDING_STOCK_SNAPSHOT,
    })
    .eq('id', id)
    .is('stock_decremented_at', null)
    .select('id')
    .maybeSingle();

  if (claimError) {
    console.error(`prepareJobMaterials: claim update failed for job ${id}:`, claimError);
    return { ok: false, error: 'The prep claim update failed — nothing was deducted; safe to retry.' };
  }

  if (!claimed) {
    // Lost the claim (already prepped) or the job vanished between read and claim.
    const job = await getJob(id);
    if (!job) return null;
    return { ok: true, alreadyDone: true };
  }

  // Row 329: build the durable snapshot from what adjustOnHandAtomic actually
  // applied (`applied`), not from `intendedDeductions` — only entries where the
  // clamp didn't zero the write are worth persisting (mirrors
  // computeStockDeductions' own "skip zero-change" filter).
  //
  // Finding 2: track which SKUs the clamp bit — a SKU whose |applied| came in
  // under what was intended (including one that clamped all the way to 0,
  // which drops out of actualDeductions entirely above) means the prep was
  // SHORT for that SKU: staff loaded a truck believing they had full stock.
  const actualDeductions: StockDeduction[] = [];
  const short: string[] = [];
  for (const d of intendedDeductions) {
    try {
      // Atomic NEGATIVE delta (mirrors receiveOrder's positive delta) so a job
      // decrement can never clobber a concurrent receipt increment (or another
      // job's decrement) on the same SKU. The old absolute set of d.after read a
      // snapshot before the atomic claim and last-write-wins dropped the racer's
      // delta — phantom stock. See adjustOnHandAtomic in onHand.ts.
      const { before, after, applied } = await adjustOnHandAtomic(db, d.sku, -d.deducted);
      if (applied !== 0) actualDeductions.push({ sku: d.sku, before, deducted: -applied, after });
      if (-applied < d.deducted) short.push(d.sku);
    } catch (err) {
      // A single failed write shouldn't unwind the claim; staff can reconcile
      // that SKU manually on the Stock tab. Log for visibility. A write that
      // never landed at all is the most extreme "short" case (0 of what was
      // intended), so it counts too.
      console.error(`prepareJobMaterials: on-hand write failed for ${d.sku}:`, err);
      short.push(d.sku);
    }
  }

  // Row 329: a SECOND write, deliberately — the true applied amounts can only
  // be known after the deduction loop above runs, and that loop can only run
  // AFTER the claim wins (so a concurrent prep can't double-deduct). Row 325's
  // "same atomic update as the claim" guarantee is therefore no longer
  // possible for an ACCURATE snapshot; this write follows immediately after,
  // scoped to the row this call already owns (no re-claim needed).
  //
  // Finding 1 (fix round 2): also guarded by `.not('stock_decremented_at',
  // 'is', null)` — a CONCURRENT cancel can only run after the claim above
  // (stock_decremented_at was non-null the instant it won), and cancel's own
  // reversal-claim clears that column back to null. If a cancel's clear lands
  // in the window between the claim and this write, this WHERE no longer
  // matches and the write correctly no-ops instead of resurrecting a stray
  // stock_deductions value on a job cancel just terminally cleared (Finding 3
  // — this scoping is what makes that currently-inert race impossible instead
  // of merely unreachable today).
  //
  // If this write fails outright, stock_deductions is left at
  // PENDING_STOCK_SNAPSHOT (stamped atomically with the claim above) rather
  // than a wrong number OR the ambiguous pre-fix null — cancel's dedicated
  // pending-snapshot branch (stockDeductions === PENDING_STOCK_SNAPSHOT) then
  // refuses to auto-reverse and asks a human to reconcile, rather than
  // silently reconstructing from a live recompute (the Row 329 bug, reopened
  // through this exact door — see Finding 1).
  try {
    const { error: snapErr } = await db
      .from('jobs')
      .update({ stock_deductions: actualDeductions })
      .eq('id', id)
      .not('stock_decremented_at', 'is', null)
      .select('id')
      .maybeSingle();
    if (snapErr) {
      console.error(`prepareJobMaterials: stock_deductions snapshot write failed for job ${id}:`, snapErr);
    }
  } catch (err) {
    console.error(`prepareJobMaterials: stock_deductions snapshot write failed for job ${id}:`, err);
  }

  // Row 386: the per-job snapshot column above is the LIVE working copy the
  // cancel route reverses — and cancel deliberately nulls it out once it's
  // used (so the job can be re-prepped later). Mirror it into the durable,
  // append-only job_stock_movements log too, so what prep actually took off
  // the shelf survives a later cancel even though the jobs-row snapshot
  // doesn't. Best-effort — never blocks the return of the deduction the job
  // DID get.
  await recordJobStockMovements(
    db,
    id,
    'prep',
    actualDeductions.map((d) => ({ sku: d.sku, qtyDelta: -d.deducted, before: d.before, after: d.after })),
  );

  return { ok: true, alreadyDone: false, deductions: actualDeductions, short };
}
