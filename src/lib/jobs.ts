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
import { getInvoiceByJob, type InvoiceRow } from './invoices';
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

// A billing-board row: the job distilled for the operator /admin/jobs list, with
// the linked quote's customer identity + is_test joined on (the job's own
// customer_id stays null until Phase 5). Mirrors the inventory FulfillmentCard
// join, but for the BILLING view — ALL statuses, newest first.
export type JobAdminCard = {
  id: string;
  jobNumber: number | null;
  quoteId: string | null;
  status: JobStatus;
  type: JobRow['type'];
  customerName: string | null;
  customerAddress: string | null;
  isTest: boolean;
  installDate: string | null;
  createdAt: string;
  itemCount: number;
};

/**
 * The jobs list for the operator billing view (/admin/jobs). Reads every job
 * (newest first) and joins each linked quote's customer name/address + is_test.
 * Test jobs stay VISIBLE here (badged) — only the dashboard metrics exclude them
 * (#93). Returns [] when Supabase isn't configured.
 */
export async function listJobsForAdmin(limit = 500): Promise<JobAdminCard[]> {
  const db = sb();
  if (!db) return [];

  const jobs = await listJobs(limit);
  if (!jobs.length) return [];

  const quoteIds = [...new Set(jobs.map((j) => j.quote_id).filter((x): x is string => !!x))];
  const byQuote = new Map<
    string,
    { name: string | null; address: string | null; isTest: boolean }
  >();
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
      byQuote.set(q.id, {
        name: q.customer_name ?? null,
        address: q.customer_address ?? null,
        isTest: !!q.is_test,
      });
    }
  }

  return jobs.map((j) => {
    const c = j.quote_id ? byQuote.get(j.quote_id) : undefined;
    return {
      id: j.id,
      jobNumber: j.job_number,
      quoteId: j.quote_id,
      status: j.status,
      type: j.type,
      customerName: c?.name ?? null,
      customerAddress: c?.address ?? null,
      isTest: c?.isTest ?? false,
      installDate: j.install_date,
      createdAt: j.created_at,
      itemCount: Array.isArray(j.line_items) ? j.line_items.length : 0,
    };
  });
}

// The full billing detail for one job (/admin/jobs/[id]): the job row, the linked
// quote's customer identity + is_test, and the linked invoice (if one exists yet).
export type JobDetail = {
  job: JobRow;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  isTest: boolean;
  invoice: InvoiceRow | null;
};

/**
 * The billing detail for one job — the job row + the linked quote's customer
 * identity + is_test + the linked invoice (null until the job is completed).
 * Returns null when Supabase isn't configured or the job is missing.
 */
export async function getJobDetail(id: string): Promise<JobDetail | null> {
  const db = sb();
  if (!db) return null;

  const job = await getJob(id);
  if (!job) return null;

  let customerName: string | null = null;
  let customerEmail: string | null = null;
  let customerPhone: string | null = null;
  let customerAddress: string | null = null;
  let isTest = false;
  if (job.quote_id) {
    const { data } = await db
      .from('quotes')
      .select('customer_name, customer_email, customer_phone, customer_address, is_test')
      .eq('id', job.quote_id)
      .maybeSingle<{
        customer_name: string | null;
        customer_email: string | null;
        customer_phone: string | null;
        customer_address: string | null;
        is_test: boolean | null;
      }>();
    if (data) {
      customerName = data.customer_name ?? null;
      customerEmail = data.customer_email ?? null;
      customerPhone = data.customer_phone ?? null;
      customerAddress = data.customer_address ?? null;
      isTest = !!data.is_test;
    }
  }

  const invoice = await getInvoiceByJob(id);
  return { job, customerName, customerEmail, customerPhone, customerAddress, isTest, invoice };
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

  // Stable customer + property identity (#83 Phase 5) the quote has been linked
  // to, if any. A SEPARATE best-effort lookup (NOT folded into the load-bearing
  // quote read above) so a DB that pre-dates Phase 5's columns nulls the linkage
  // rather than failing job creation — same pattern as the design_id lookup.
  let customerId: string | null = null;
  let propertyId: string | null = null;
  const { data: ids } = await db
    .from('quotes')
    .select('customer_id, property_id')
    .eq('id', quoteId)
    .maybeSingle<{ customer_id: string | null; property_id: string | null }>();
  if (ids) {
    customerId = ids.customer_id ?? null;
    propertyId = ids.property_id ?? null;
  }

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
      customer_id: customerId,
      property_id: propertyId,
      type,
      status: 'to_schedule' satisfies JobStatus,
      // fulfillment_stage intentionally omitted (NULL) — owned by #82.
      line_items: quote.result?.lineItems ?? null,
      ...(jobNumber != null ? { job_number: jobNumber } : {}),
    })
    .select(JOB_SELECT)
    .single();

  if (error) {
    // Lost a concurrent insert race (the partial unique index on quote_id
    // fired)? Converge on the winner's row instead of a spurious null, so the
    // creator is self-sufficiently idempotent. (The webhook's atomic deposit
    // claim makes this unreachable today, but it no longer leans solely on it.)
    if ((error as { code?: string }).code === '23505') {
      const winner = await getJobByQuote(quoteId);
      if (winner) return winner;
    }
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
 *
 * W1-023: the read-then-canTransition check is advisory only — the UPDATE carries
 * `.eq('status', current.status)` so it is a compare-and-swap, not an unconditional
 * write. A concurrent transition that moved the row between our read and this write
 * (e.g. a cancel landing while a close is in flight) matches 0 rows; we treat that
 * as a lost race (re-read once — return the fresh row if someone else already
 * applied the same target, else null) rather than clobbering the winner's state.
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

  const { data, error } = await db
    .from('jobs')
    .update(patch)
    .eq('id', id)
    .eq('status', current.status)
    .select(JOB_SELECT)
    .single();
  if (error) {
    // 0 rows OR a real error. Lost-race disambiguation (W1-023): re-read once. If
    // the row already reached the target (a concurrent request applied the same
    // transition), return it as an idempotent success; otherwise the race was
    // divergent (or the row is gone) → null, the same "couldn't apply" the callers
    // already handle.
    const fresh = await getJob(id);
    if (fresh && fresh.status === to) return fresh;
    console.error('setJobStatus error:', error);
    return null;
  }
  return data as unknown as JobRow;
}

// TODO #83 Phase 2 + #81: admin jobs page (/admin/jobs list + detail) and a
// /api/jobs route are NEW operator surfaces gated on the #81 auth perimeter —
// deferred until that lands. The dashboard Workflow board (existing surface)
// reads jobs server-side and is fine now.
