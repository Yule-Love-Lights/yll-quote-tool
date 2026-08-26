// Workflow board — the Jobber-style pipeline view (ledger #83).
// The QUOTES column buckets by the canonical quote status (src/lib/quoteStatus.ts)
// derived from the existing lifecycle timestamps. The JOBS column (Phase 2)
// buckets the `jobs` table by billing status (src/lib/jobStatus.ts). The
// Invoices column lands in #83 Phase 3 (placeholder in the UI for now).

import type { DashboardQuote } from './types';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { JOB_STATUSES, asJobStatus, type JobStatus } from '@/lib/jobStatus';
import { INVOICE_STATUSES, asInvoiceStatus, type InvoiceStatus } from '@/lib/invoiceStatus';

/** A single status cell on the board: how many items and their total value.
 *  `staleCount` (row 389, S49): how many of `count` are invoices this repo
 *  already knows are provisional (a frozen re-sync — see WorkflowInvoice.stale)
 *  — 0 for the quotes/jobs columns, which never set the underlying flag. */
export type StageBucket = { count: number; totalUsd: number; staleCount: number };

/** The minimal job shape the board aggregates (read server-side from `jobs`). */
export type WorkflowJob = {
  status: string | null;
  line_items: Array<{ amount?: number | null }> | null;
};

/** The minimal invoice shape the board aggregates (read server-side from
 *  `invoices`). The column's money lens is the OUTSTANDING balance (what's still
 *  to collect), so we only need the status + balance — not the full total. */
export type WorkflowInvoice = {
  status: string | null;
  balance: number | null;
  // Row 389 (S49, admin lens MED): true when this repo already knows the
  // invoice's total/balance is a frozen, unreconciled figure (row 378's
  // customer-side refusal or row 341's staff-side re-sync failure) — see
  // isStaleInvoiceSnapshot in quoteAmendInvoiceSync.ts, the single place
  // that derives it (queries.ts calls it; this module stays pure/no-IO and
  // just carries the already-computed flag). Optional so every existing
  // fixture/caller that predates this field keeps compiling as "not stale".
  stale?: boolean;
};

export type WorkflowBoard = {
  /**
   * The QUOTES column, bucketed by the lifecycle states a dashboard quote row
   * can actually reach. `deriveStatus` can name nine statuses, but the
   * dashboard query only selects the lifecycle timestamps (not `viewed_at` /
   * the persisted `status`), so a row here resolves to one of:
   * draft → sent/viewed → booked. Row 327: an 'approved' (customer signed,
   * deposit not yet paid) quote folds into `awaitingResponse`, mirroring
   * quoteStatus.ts's APPROVED_DISPLAYS_AS/statusMatchesFilter convention —
   * ledger row 242 already ruled there is no separate 'approved' stage
   * anywhere else in the quote lane, so this board doesn't invent one either.
   */
  quotes: {
    draft: StageBucket;
    awaitingResponse: StageBucket; // status 'sent' | 'viewed' | 'approved'
    booked: StageBucket;
  };
  /** Per billing-status buckets for the JOBS column (Phase 2). */
  jobs: Record<JobStatus, StageBucket>;
  /** Per billing-status buckets for the INVOICES column (Phase 3). Each bucket's
   *  totalUsd is the summed OUTSTANDING balance for that status. */
  invoices: Record<InvoiceStatus, StageBucket>;
};

function emptyBucket(): StageBucket {
  return { count: 0, totalUsd: 0, staleCount: 0 };
}

/**
 * Terminal statuses (B7 fix): a quote in a terminal state must not appear in
 * any forward-progress board bucket. deriveStatus returns these only when the
 * persisted `status` column carries them (timestamps alone can't express them),
 * so the fix depends on `status` being selected by DASHBOARD_QUOTES_SELECT.
 */
const TERMINAL_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  'cancelled',
  'declined',
  'abandoned',
  'changes_requested',
]);

function emptyJobBuckets(): Record<JobStatus, StageBucket> {
  return Object.fromEntries(JOB_STATUSES.map((s) => [s, emptyBucket()])) as Record<
    JobStatus,
    StageBucket
  >;
}

function emptyInvoiceBuckets(): Record<InvoiceStatus, StageBucket> {
  return Object.fromEntries(INVOICE_STATUSES.map((s) => [s, emptyBucket()])) as Record<
    InvoiceStatus,
    StageBucket
  >;
}

function jobValueUsd(job: WorkflowJob): number {
  return (job.line_items ?? []).reduce((sum, li) => sum + (li.amount ?? 0), 0);
}

export function computeWorkflowBoard(
  quotes: DashboardQuote[],
  jobs: WorkflowJob[] = [],
  invoices: WorkflowInvoice[] = [],
): WorkflowBoard {
  const draft = emptyBucket();
  const awaitingResponse = emptyBucket();
  const booked = emptyBucket();

  for (const q of quotes) {
    const status = deriveStatus(q);
    // B7 fix: skip terminal-status orders — they must not inflate any
    // forward-progress bucket (booked/sent/draft).
    if (TERMINAL_STATUSES.has(status)) continue;
    // Row 327: 'approved' folds into awaitingResponse alongside sent/viewed —
    // see the `quotes` type doc comment above.
    const bucket =
      status === 'booked'
        ? booked
        : status === 'sent' || status === 'viewed' || status === 'approved'
          ? awaitingResponse
          : draft;
    bucket.count += 1;
    bucket.totalUsd += q.total ?? 0;
  }

  // Jobs: bucket by billing status. An unknown/legacy status falls back to
  // 'to_schedule' (a fresh job's starting state) so a row is never dropped.
  const jobBuckets = emptyJobBuckets();
  for (const j of jobs) {
    const status = asJobStatus(j.status) ?? 'to_schedule';
    jobBuckets[status].count += 1;
    jobBuckets[status].totalUsd += jobValueUsd(j);
  }

  // Invoices: bucket by billing status; the value is the OUTSTANDING balance
  // (what's still to collect). An unknown/legacy/null status falls back to
  // 'draft' (a fresh invoice's starting state) so a row is never dropped.
  const invoiceBuckets = emptyInvoiceBuckets();
  for (const inv of invoices) {
    const status = asInvoiceStatus(inv.status) ?? 'draft';
    invoiceBuckets[status].count += 1;
    invoiceBuckets[status].totalUsd += inv.balance ?? 0;
    // Row 389: flag, don't exclude — a total that quietly drops a row is its
    // own lie (per the ledger row's own reasoning). The bucket still sums
    // the stale balance as before; staleCount tells the owner it's provisional.
    if (inv.stale) invoiceBuckets[status].staleCount += 1;
  }

  return {
    quotes: { draft, awaitingResponse, booked },
    jobs: jobBuckets,
    invoices: invoiceBuckets,
  };
}
