// src/lib/inventory/jobs.ts
// FULFILLMENT side of the SHARED `jobs` table (#82 Slice 3). The billing side
// (src/lib/jobs.ts) is the SINGLE creator — a job is auto-created on the
// deposit-paid Valor webhook. This module reads those same rows for the materials
// / fulfillment Kanban and updates ONLY `fulfillment_stage`; it never inserts a
// job. See the unified migration 2026-06-27-jobs.sql + design spec §8 (Slice 3).

import { getSupabaseServiceClient } from '../supabase';
import { listJobs, type JobRow } from '../jobs';
import type { JobStatus } from '../jobStatus';
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
};

// Pure: bucket cards into the four columns (every column present, stable order).
export function groupByStage(cards: FulfillmentCard[]): Record<FulfillmentStage, FulfillmentCard[]> {
  const out = Object.fromEntries(
    FULFILLMENT_STAGES.map((s) => [s, [] as FulfillmentCard[]]),
  ) as Record<FulfillmentStage, FulfillmentCard[]>;
  for (const c of cards) out[c.stage].push(c);
  return out;
}

function toCard(j: JobRow, cust?: { name: string | null; address: string | null }): FulfillmentCard {
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
  const custById = new Map<string, { name: string | null; address: string | null }>();
  if (quoteIds.length) {
    const { data } = await db
      .from('quotes')
      .select('id, customer_name, customer_address')
      .in('id', quoteIds);
    for (const q of (data ?? []) as { id: string; customer_name: string | null; customer_address: string | null }[]) {
      custById.set(q.id, { name: q.customer_name ?? null, address: q.customer_address ?? null });
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
