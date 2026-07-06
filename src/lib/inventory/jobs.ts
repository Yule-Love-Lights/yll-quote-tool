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
import { getInventoryBindings } from './bindings';
import { listCatalog } from './catalog';
import { listOnHand, upsertOnHand } from './onHand';
import { projectMaterials, buildMaterialsView, type MaterialsView } from './materialsProjection';
import { colorChoiceFromSnapshot } from './resolveInstalls';
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
  cust?: { name: string | null; address: string | null; isTest?: boolean },
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
  const custById = new Map<string, { name: string | null; address: string | null; isTest: boolean }>();
  if (quoteIds.length) {
    const { data } = await db
      .from('quotes')
      .select('id, customer_name, customer_address, is_test')
      .in('id', quoteIds);
    for (const q of (data ?? []) as {
      id: string;
      customer_name: string | null;
      customer_address: string | null;
      is_test: boolean | null;
    }[]) {
      custById.set(q.id, {
        name: q.customer_name ?? null,
        address: q.customer_address ?? null,
        isTest: !!q.is_test,
      });
    }
  }

  return jobs.map((j) => toCard(j, j.quote_id ? custById.get(j.quote_id) : undefined));
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
  // Test Quote (ledger #93): derived from the linked quote. Drives the TEST
  // badge + makes prepareJobMaterials no-op the real on-hand deduction.
  isTest: boolean;
};
export type WorkOrder = { job: WorkOrderJob; materials: MaterialsView };

export async function getJobWorkOrder(id: string): Promise<WorkOrder | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const job = await getJob(id);
  if (!job) return null;

  // The #82 stock-prep flag lives outside the billing JobRow — read it directly.
  const { data: sd } = await db.from('jobs').select('stock_decremented_at').eq('id', id).maybeSingle();
  const stockDecrementedAt = (sd as { stock_decremented_at: string | null } | null)?.stock_decremented_at ?? null;

  // Materials from the job's linked design (by quote_id), mirroring the 2d view.
  let scene: Scene = { yardsticks: [], items: [] };
  let customerName: string | null = null;
  let customerAddress: string | null = null;
  let isTest = false;
  let colorChoice: string[] | null = null; // #92 — the customer's approved color pick
  if (job.quote_id) {
    const [{ data: design }, { data: quote }] = await Promise.all([
      db.from('designs').select('scene').eq('quote_id', job.quote_id).maybeSingle(),
      db.from('quotes').select('customer_name, customer_address, is_test, approval_snapshot').eq('id', job.quote_id).maybeSingle(),
    ]);
    if (design?.scene) scene = design.scene as Scene;
    if (quote) {
      const q = quote as { customer_name: string | null; customer_address: string | null; is_test: boolean | null; approval_snapshot: unknown };
      customerName = q.customer_name ?? null;
      customerAddress = q.customer_address ?? null;
      isTest = !!q.is_test;
      colorChoice = colorChoiceFromSnapshot(q.approval_snapshot);
    }
  }

  // #110 W7-009: pass clipRules through (see purchaseOrder.ts) so the job work
  // order / print sheet / order email / prep stock-deduction include clips too.
  const { bindings, clipRules } = await getInventoryBindings();
  const lines = projectMaterials(scene, bindings, clipRules, colorChoice);
  const [catalog, onHand] = await Promise.all([listCatalog(), listOnHand()]);
  const nameOf = new Map(catalog.map((c) => [c.sku, c.name]));
  const onHandOf = new Map(onHand.map((r) => [r.sku, r.on_hand_qty]));
  const materials = buildMaterialsView(
    lines,
    (sku) => nameOf.get(sku),
    (sku) => (onHandOf.has(sku) ? (onHandOf.get(sku) as number) : null),
  );

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
      isTest,
    },
    materials,
  };
}

// ── Phase 2: stock loop (decrement on prep) ──────────────────────────────────

export type StockDeduction = { sku: string; before: number; deducted: number; after: number };

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
  | { ok: true; alreadyDone: false; deductions: StockDeduction[] };

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

  // Atomic claim — only the caller that flips NULL → now() proceeds to deduct.
  const { data: claimed } = await db
    .from('jobs')
    .update({ stock_decremented_at: new Date().toISOString(), fulfillment_stage: 'ready_for_install' })
    .eq('id', id)
    .is('stock_decremented_at', null)
    .select('id')
    .maybeSingle();

  if (!claimed) {
    // Lost the claim (already prepped) or no such job. Distinguish for the caller.
    const job = await getJob(id);
    if (!job) return null;
    return { ok: true, alreadyDone: true };
  }

  // Won the claim → deduct on-hand for the job's tracked materials.
  // Test Quote safety (ledger #93): a test job advances through prep + the Kanban
  // exactly like a real one (the claim above already marked it prepped + advanced
  // the stage), but it must NEVER touch real on-hand. Skip the deduction entirely
  // — an empty result, so the UI shows "prepped" with no phantom stock change.
  const wo = await getJobWorkOrder(id);
  const deductions = wo && !wo.job.isTest ? computeStockDeductions(wo.materials.materials) : [];
  for (const d of deductions) {
    try {
      await upsertOnHand({ sku: d.sku, on_hand_qty: d.after });
    } catch (err) {
      // A single failed write shouldn't unwind the claim; staff can reconcile
      // that SKU manually on the Stock tab. Log for visibility.
      console.error(`prepareJobMaterials: on-hand write failed for ${d.sku}:`, err);
    }
  }
  return { ok: true, alreadyDone: false, deductions };
}
