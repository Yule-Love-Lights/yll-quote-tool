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
import { readLaborPlan, type LaborPlan } from './laborPlan';
import { allocateNumber } from './displayId';
import { canTransition, type JobStatus } from './jobStatus';
import { getInvoiceByJob, type InvoiceRow } from './invoices';
import { estimateLaborForQuote } from './laborEstimate';
import type { LineItem } from './pricing/pricingEngine';
import { asServiceType } from './serviceType';
import type { AmendmentTrailEntry } from './amend';
import { approvedColorLabelForQuote } from '@/lib/design/approvedColorLabels';

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
  budgeted_hours: number | null;
  labor_revenue_cents: number | null;
  rates_are_placeholder: boolean;
  install_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

const JOB_SELECT =
  'id, job_number, quote_id, design_id, customer_id, property_id, type, status, ' +
  'fulfillment_stage, line_items, budgeted_hours, labor_revenue_cents, rates_are_placeholder, ' +
  'install_date, completed_at, created_at, updated_at';

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

/**
 * PURE: merge job lists (e.g. one matched by customer_id, one by quote_id) into a
 * single de-duplicated, newest-first list. No IO — exported for direct unit tests.
 */
export function mergeJobsNewestFirst(...lists: JobRow[][]): JobRow[] {
  const byId = new Map<string, JobRow>();
  for (const list of lists) {
    for (const j of list) byId.set(j.id, j);
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/**
 * Jobs belonging to a customer (the customer detail page, #58): matched by EITHER
 * the job's own customer_id OR its quote_id being one of the customer's known
 * quotes (the page's Quote history) — the second leg covers legacy jobs whose
 * customer_id is still null pre-backfill, mirroring matchesCustomerRoute's dual
 * match. Two queries + merge-dedupe (mergeJobsNewestFirst) rather than a
 * hand-built PostgREST `.or()` filter. Returns [] when Supabase isn't configured
 * or neither a customerId nor any quoteIds are given.
 */
export async function listJobsForCustomer(
  customerId: string | null,
  quoteIds: string[],
): Promise<JobRow[]> {
  const db = sb();
  if (!db) return [];
  if (!customerId && quoteIds.length === 0) return [];

  let byCustomer: JobRow[] = [];
  if (customerId) {
    const { data, error } = await db.from('jobs').select(JOB_SELECT).eq('customer_id', customerId);
    if (error) console.error('listJobsForCustomer: customer_id query error:', error);
    else byCustomer = (data ?? []) as unknown as JobRow[];
  }

  let byQuote: JobRow[] = [];
  if (quoteIds.length) {
    const { data, error } = await db.from('jobs').select(JOB_SELECT).in('quote_id', quoteIds);
    if (error) console.error('listJobsForCustomer: quote_id query error:', error);
    else byQuote = (data ?? []) as unknown as JobRow[];
  }

  return mergeJobsNewestFirst(byCustomer, byQuote);
}

// A billing-board row: the job distilled for the operator /admin/jobs list, with
// the linked quote's customer identity + is_test joined on (the job's own
// customer_id stays null until Phase 5). Mirrors the inventory FulfillmentCard
// join, but for the BILLING view — ALL statuses, newest first.
//
// WT-19: `installDate` was removed from this card (2026-07-13) — nothing ever
// writes a job's install_date, so the /admin/jobs Install column always read
// "—". JobRow.install_date itself is left in place (still selected + typed)
// because other operator surfaces outside this file's scope still read it.
export type JobAdminCard = {
  id: string;
  jobNumber: number | null;
  quoteId: string | null;
  status: JobStatus;
  type: JobRow['type'];
  customerName: string | null;
  customerAddress: string | null;
  isTest: boolean;
  // #199: the linked quote's NCE tag — drives the NceBadge on the list row.
  isNce: boolean;
  createdAt: string;
  itemCount: number;
  // Customer detail-page route id fields (same precedence as QuoteListItem /
  // src/lib/dashboard/customers.ts customerRouteId: highlevel_contact_id, else
  // customer_id) — lets /admin/jobs link a customer name to their profile.
  // customerId prefers the job's OWN customer_id (Phase 5) over the linked
  // quote's, since the job row is the more direct source once backfilled.
  highlevelContactId: string | null;
  customerId: string | null;
};

/**
 * The jobs list for the operator billing view (/admin/jobs). Reads every job
 * (newest first) and joins each linked quote's customer name/address +
 * is_test/is_nce. Test jobs stay VISIBLE here (badged) — only the dashboard
 * metrics exclude them (#93). Returns [] when Supabase isn't configured.
 */
export async function listJobsForAdmin(limit = 500): Promise<JobAdminCard[]> {
  const db = sb();
  if (!db) return [];

  const jobs = await listJobs(limit);
  if (!jobs.length) return [];

  const quoteIds = [...new Set(jobs.map((j) => j.quote_id).filter((x): x is string => !!x))];
  const byQuote = new Map<
    string,
    { name: string | null; address: string | null; isTest: boolean; isNce: boolean; highlevelContactId: string | null; customerId: string | null }
  >();
  if (quoteIds.length) {
    const { data } = await db
      .from('quotes')
      .select('id, customer_name, customer_address, is_test, is_nce, highlevel_contact_id, customer_id')
      .in('id', quoteIds);
    for (const q of (data ?? []) as {
      id: string;
      customer_name: string | null;
      customer_address: string | null;
      is_test: boolean | null;
      is_nce: boolean | null;
      highlevel_contact_id: string | null;
      customer_id: string | null;
    }[]) {
      byQuote.set(q.id, {
        name: q.customer_name ?? null,
        address: q.customer_address ?? null,
        isTest: !!q.is_test,
        isNce: !!q.is_nce,
        highlevelContactId: q.highlevel_contact_id ?? null,
        customerId: q.customer_id ?? null,
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
      isNce: c?.isNce ?? false,
      createdAt: j.created_at,
      itemCount: Array.isArray(j.line_items) ? j.line_items.length : 0,
      highlevelContactId: c?.highlevelContactId ?? null,
      customerId: j.customer_id ?? c?.customerId ?? null,
    };
  });
}

// The full billing detail for one job (/admin/jobs/[id]): the job row, the linked
// quote's customer identity + is_test/is_nce, and the linked invoice (if one exists yet).
export type JobDetail = {
  job: JobRow;
  /**
   * Row 362: the light colour/pattern the customer APPROVED, as an
   * operator-facing label ("Champagne", "Custom pattern", "Staff's pick").
   * null when the linked quote has no approved selection, or there is no
   * linked quote at all.
   *
   * The crew builds from this screen, so the colour has to be readable here
   * and not only on the quote page — a booked order whose colour lives one
   * click away is how a customer ends up with the wrong lights on the house.
   */
  lightColorLabel: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  isTest: boolean;
  // #199: the linked quote's NCE tag — drives the NceBadge on the detail header.
  isNce: boolean;
  // The linked quote's service_type (#117), for surfaces that need to tell a
  // 'permanent_bistro' one_off job apart from an ordinary holiday/event one_off
  // (the type column alone collapses both to 'one_off' — see createJobFromQuote's
  // comment). null when the job has no linked quote or the column is unset.
  quoteServiceType: string | null;
  invoice: InvoiceRow | null;
  // #177 fix 4: the linked quote's stamped deposit_amount_usd (the deposit
  // actually INTENDED at this quote's own deposit percent) — fed into
  // reconcileInvoice alongside `invoice` so short-deposit compares against
  // the real intended amount, not a blanket 40%-of-total heuristic.
  intendedDepositUsd: number | null;
  // The job's labor numbers in tagged form. `job` above still carries the raw
  // columns, which is fine for callers inside this repo (the ESLint rule in
  // eslint.config.mjs stops them being read directly), but this detail object
  // is serialized wholesale by GET /api/jobs/[id] and read by out-of-repo
  // consumers that no lint rule can reach. Shipping the tagged form alongside
  // means such a consumer gets `status: 'placeholder'` in the payload itself,
  // instead of a bare number that looks measured. See src/lib/laborPlan.ts.
  laborPlan: LaborPlan;
  // Ledger #83 follow-up (a real live incident): the linked quote's amendment
  // trail, so the operator recording an amendment on THIS job page can see
  // whether an earlier one is still awaiting the customer's answer or was
  // DECLINED — previously invisible here (only /admin/quotes/[id] rendered
  // it). Empty array when the job has no linked quote or none was amended.
  amendments: AmendmentTrailEntry[];
};

/**
 * The billing detail for one job — the job row + the linked quote's customer
 * identity + is_test/is_nce + service_type + the linked invoice (null until the
 * job is completed). Returns null when Supabase isn't configured or the job is missing.
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
  let isNce = false;
  let quoteServiceType: string | null = null;
  let intendedDepositUsd: number | null = null;
  let amendments: AmendmentTrailEntry[] = [];
  let lightColorLabel: string | null = null;
  if (job.quote_id) {
    const { data } = await db
      .from('quotes')
      .select('customer_name, customer_email, customer_phone, customer_address, is_test, is_nce, service_type, deposit_amount_usd, approval_snapshot')
      .eq('id', job.quote_id)
      .maybeSingle<{
        customer_name: string | null;
        customer_email: string | null;
        customer_phone: string | null;
        customer_address: string | null;
        is_test: boolean | null;
        is_nce: boolean | null;
        service_type: string | null;
        deposit_amount_usd: number | null;
        approval_snapshot: { amendments?: AmendmentTrailEntry[]; customerSelection?: { colorSchemeId?: string; customPattern?: string[] } } | null;
      }>();
    if (data) {
      customerName = data.customer_name ?? null;
      customerEmail = data.customer_email ?? null;
      customerPhone = data.customer_phone ?? null;
      customerAddress = data.customer_address ?? null;
      isTest = !!data.is_test;
      isNce = !!data.is_nce;
      quoteServiceType = data.service_type ?? null;
      intendedDepositUsd = data.deposit_amount_usd ?? null;
      amendments = Array.isArray(data.approval_snapshot?.amendments)
        ? data.approval_snapshot.amendments
        : [];
      // Row 362: same snapshot this join already reads for the amendment
      // trail — no extra query. service_type is REQUIRED: permanent quotes
      // freeze into a different swatch id space, and resolving against the
      // wrong one silently renders "Staff's pick" instead of the real colour.
      lightColorLabel = await approvedColorLabelForQuote(data.approval_snapshot, data.service_type);
    }
  }

  const invoice = await getInvoiceByJob(id);
  return {
    job,
    lightColorLabel,
    customerName,
    customerEmail,
    customerPhone,
    customerAddress,
    isTest,
    isNce,
    quoteServiceType,
    amendments,
    invoice,
    intendedDepositUsd,
    laborPlan: readLaborPlan(job),
  };
}

// The minimal quote shape createJobFromQuote needs.
type QuoteForJob = {
  id: string;
  service_type: string | null;
  inputs: unknown;
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
    .select('id, service_type, inputs, result')
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
  // Permanent BISTRO (#117) books as one_off ON PURPOSE for v1: 'permanent'
  // jobs feed the APL puck/track BOM + Glow365 ops machinery, none of which
  // applies to café string lights. Revisit if bistro grows its own ops track.
  const type: JobRow['type'] = quote.service_type === 'permanent' ? 'permanent' : 'one_off';
  const serviceType = asServiceType(quote.service_type);
  const estimate = serviceType ? estimateLaborForQuote(serviceType, quote.inputs) : null;
  if (!estimate) {
    const rawType = quote.service_type ?? 'null';
    console.warn(
      `createJobFromQuote: budgeted-hours estimate skipped for quote ${quoteId} (service_type=${rawType}).`,
    );
  }

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
      budgeted_hours: estimate?.budgetedHours ?? null,
      labor_revenue_cents: estimate?.laborRevenueCents ?? null,
      // Only true when an estimate was actually computed WITH placeholder
      // rates. A job with no estimate at all (missing/malformed geometry —
      // the console.warn case above) has nothing placeholder about it; it
      // needs a full re-estimate once the underlying data issue is fixed,
      // not a rate recompute. Keeping these two "needs attention" reasons
      // distinguishable is what makes a future `WHERE rates_are_placeholder`
      // recompute query correct instead of silently skipping (false) or
      // wrongly including (stuck at true) the no-estimate case.
      rates_are_placeholder: estimate != null,
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

// #83 Phase 2 + #81: the admin jobs page (/admin/jobs list + detail) and the
// /api/jobs route are LIVE operator surfaces, gated behind the #81 auth
// perimeter (requireOperator()). The dashboard Workflow board (existing
// surface) also reads jobs server-side.
