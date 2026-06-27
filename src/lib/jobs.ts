// Jobs data layer — the BILLING side of the SHARED `jobs` table (ledger #83
// Phase 2). A Job is auto-created when a quote is booked (deposit paid); it
// snapshots the quote's line items and links back to the quote + its design.
//
// 🔗 SHARED table with the Inventory epic #82. This module is the SINGLE creator
// of a job row (createJobFromQuote, idempotent on quote_id). #82's
// src/lib/inventory/jobs.ts is the FULFILLMENT side against the SAME row — it
// EXTENDS the job (sets `fulfillment_stage`, reads `design_id` → materials),
// it never inserts a second job for the same quote. Migration: the unified
// `migrations/2026-06-27-jobs.sql`.

import { getSupabaseServiceClient, getSupabaseClient } from './supabase';
import { allocateNumber } from './displayId';
import { canTransition, type JobStatus } from './jobStatus';
import type { LineItem } from './pricing/pricingEngine';

// The job row as the billing side reads/writes it. `fulfillment_stage` is the
// #82 axis — present in the type for completeness but owned by inventory.
export type JobRow = {
  id: string;
  job_number: number | null;
  quote_id: string | null;
  design_id: string | null;
  customer_id: string | null;
  property_id: string | null;
  type: 'one_off' | 'permanent';
  status: JobStatus;
  fulfillment_stage: string | null;
  line_items: LineItem[] | null;
  install_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

const JOB_SELECT =
  'id, job_number, quote_id, design_id, customer_id, property_id, type, status, ' +
  'fulfillment_stage, line_items, install_date, completed_at, created_at, updated_at';

function sb() {
  return getSupabaseServiceClient() ?? getSupabaseClient();
}

/** The single job linked to a quote, if one has been created. */
export async function getJobByQuote(quoteId: string): Promise<JobRow | null> {
  const db = sb();
  if (!db) return null;
  const { data, error } = await db
    .from('jobs')
    .select(JOB_SELECT)
    .eq('quote_id', quoteId)
    .maybeSingle();
  if (error) {
    console.error('getJobByQuote error:', error);
    return null;
  }
  return (data as JobRow | null) ?? null;
}

export async function getJob(id: string): Promise<JobRow | null> {
  const db = sb();
  if (!db) return null;
  const { data, error } = await db.from('jobs').select(JOB_SELECT).eq('id', id).maybeSingle();
  if (error) {
    console.error('getJob error:', error);
    return null;
  }
  return (data as JobRow | null) ?? null;
}

export async function listJobs(limit = 500): Promise<JobRow[]> {
  const db = sb();
  if (!db) return [];
  const { data, error } = await db
    .from('jobs')
    .select(JOB_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listJobs error:', error);
    return [];
  }
  return (data ?? []) as unknown as JobRow[];
}

// The minimal quote shape createJobFromQuote needs.
type QuoteForJob = {
  id: string;
  service_type: string | null;
  result: { lineItems?: LineItem[] } | null;
};

/**
 * Auto-create a Job from a booked quote. IDEMPOTENT: if a job already exists for
 * this quote, returns it without creating a second (the unique index on
 * jobs.quote_id is the DB-level backstop; this is the in-code guard the webhook
 * relies on so a Valor retry never double-creates). Returns null if Supabase is
 * not configured or the quote doesn't exist.
 *
 * Snapshots `line_items` from the quote's priced result, links `quote_id` +
 * `design_id` (the quote's design, if any), sets `type` from the quote's
 * `service_type`, allocates a `job_number`, and starts the billing lifecycle at
 * `to_schedule`. Leaves `fulfillment_stage` NULL — that's the #82 inventory axis.
 */
export async function createJobFromQuote(quoteId: string): Promise<JobRow | null> {
  const db = sb();
  if (!db) return null;

  // Idempotency guard — already have a job for this quote? Return it untouched.
  const existing = await getJobByQuote(quoteId);
  if (existing) return existing;

  // Load the quote we're snapshotting from.
  const { data: quote, error: qErr } = await db
    .from('quotes')
    .select('id, service_type, result')
    .eq('id', quoteId)
    .maybeSingle<QuoteForJob>();
  if (qErr) {
    console.error('createJobFromQuote: quote read error:', qErr);
    return null;
  }
  if (!quote) {
    console.warn(`createJobFromQuote: no quote ${quoteId}`);
    return null;
  }

  // The design this job draws materials from (#82), if the quote has one. A
  // lightweight id-only lookup — we don't need the full design / signed URLs.
  let designId: string | null = null;
  const { data: design } = await db
    .from('designs')
    .select('id')
    .eq('quote_id', quoteId)
    .maybeSingle<{ id: string }>();
  if (design) designId = design.id;

  // Job type from the quote's service line. Holiday/event = one-off; permanent
  // (Glow365) carries the recurring type now (recurring billing is deferred).
  const type: JobRow['type'] = quote.service_type === 'permanent' ? 'permanent' : 'one_off';

  // Sequential display number (Job #1000…). Best-effort, exactly like
  // saveQuote's quote_number: a failed allocation (sequence missing pre-migration)
  // must NOT block the job — the column is nullable. Omit the key on failure so
  // the insert works against a DB that pre-dates the migration.
  let jobNumber: number | null = null;
  try {
    jobNumber = await allocateNumber('job_number_seq');
  } catch (err) {
    console.warn('createJobFromQuote: job_number allocation skipped:', err);
  }

  const { data, error } = await db
    .from('jobs')
    .insert({
      quote_id: quote.id,
      design_id: designId,
      type,
      status: 'to_schedule' satisfies JobStatus,
      // fulfillment_stage intentionally omitted (NULL) — owned by #82.
      line_items: quote.result?.lineItems ?? null,
      ...(jobNumber != null ? { job_number: jobNumber } : {}),
    })
    .select(JOB_SELECT)
    .single();

  if (error) {
    console.error('createJobFromQuote: insert error:', error);
    return null;
  }
  return data as unknown as JobRow;
}

/**
 * Move a job to a new billing status, guarded by the legal-transition table
 * (src/lib/jobStatus.ts). Throws on an illegal transition (a programmer/UI
 * error, not a user one). Stamps `completed_at` when reaching `done`. Returns
 * null if Supabase isn't configured or the job doesn't exist.
 */
export async function setJobStatus(id: string, to: JobStatus): Promise<JobRow | null> {
  const db = sb();
  if (!db) return null;

  const current = await getJob(id);
  if (!current) return null;

  if (!canTransition(current.status, to)) {
    throw new Error(`setJobStatus: illegal transition ${current.status} → ${to} (job ${id})`);
  }

  const patch: Record<string, unknown> = { status: to };
  if (to === 'done') patch.completed_at = new Date().toISOString();

  const { data, error } = await db.from('jobs').update(patch).eq('id', id).select(JOB_SELECT).single();
  if (error) {
    console.error('setJobStatus error:', error);
    return null;
  }
  return data as unknown as JobRow;
}

// TODO #83 Phase 2 + #81: admin jobs page (/admin/jobs list + detail) and a
// /api/jobs route are NEW operator surfaces gated on the #81 auth perimeter —
// deferred until that lands. The dashboard Workflow board (existing surface)
// reads jobs server-side and is fine now.
