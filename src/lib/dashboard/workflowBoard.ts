// Workflow board — the Jobber-style pipeline view (ledger #83).
// The QUOTES column buckets by the canonical quote status (src/lib/quoteStatus.ts)
// derived from the existing lifecycle timestamps. The JOBS column (Phase 2)
// buckets the `jobs` table by billing status (src/lib/jobStatus.ts). The
// Invoices column lands in #83 Phase 3 (placeholder in the UI for now).

import type { DashboardQuote } from './types';
import { deriveStatus } from '@/lib/quoteStatus';
import { JOB_STATUSES, asJobStatus, type JobStatus } from '@/lib/jobStatus';

/** A single status cell on the board: how many items and their total value. */
export type StageBucket = { count: number; totalUsd: number };

/** The minimal job shape the board aggregates (read server-side from `jobs`). */
export type WorkflowJob = {
  status: string | null;
  line_items: Array<{ amount?: number | null }> | null;
};

export type WorkflowBoard = {
  /**
   * The QUOTES column, bucketed by the four lifecycle states a dashboard quote
   * row can actually reach. `deriveStatus` can name nine statuses, but the
   * dashboard query only selects the lifecycle timestamps (not `viewed_at` /
   * the persisted `status`), so a row here resolves to exactly one of:
   * draft → sent → approved → booked. We bucket to those four rather than
   * inventing always-zero rows for the unreachable states.
   */
  quotes: {
    draft: StageBucket;
    awaitingResponse: StageBucket; // status 'sent' — sent, awaiting the customer
    approved: StageBucket;
    booked: StageBucket;
  };
  /** Per billing-status buckets for the JOBS column (Phase 2). */
  jobs: Record<JobStatus, StageBucket>;
};

function emptyBucket(): StageBucket {
  return { count: 0, totalUsd: 0 };
}

function emptyJobBuckets(): Record<JobStatus, StageBucket> {
  return Object.fromEntries(JOB_STATUSES.map((s) => [s, emptyBucket()])) as Record<
    JobStatus,
    StageBucket
  >;
}

function jobValueUsd(job: WorkflowJob): number {
  return (job.line_items ?? []).reduce((sum, li) => sum + (li.amount ?? 0), 0);
}

export function computeWorkflowBoard(
  quotes: DashboardQuote[],
  jobs: WorkflowJob[] = [],
): WorkflowBoard {
  const draft = emptyBucket();
  const awaitingResponse = emptyBucket();
  const approved = emptyBucket();
  const booked = emptyBucket();

  for (const q of quotes) {
    const status = deriveStatus(q);
    const bucket =
      status === 'booked'
        ? booked
        : status === 'approved'
          ? approved
          : status === 'sent'
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

  return { quotes: { draft, awaitingResponse, approved, booked }, jobs: jobBuckets };
}
