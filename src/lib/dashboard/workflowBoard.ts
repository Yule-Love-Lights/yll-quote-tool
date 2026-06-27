// Workflow board — the Jobber-style pipeline view (ledger #83, Phase 2 start).
// Phase-1 slice: the QUOTES stage, bucketed by the canonical quote status
// (src/lib/quoteStatus.ts) derived from the existing lifecycle timestamps. The
// Jobs and Invoices stages land in #83 Phase 2/3 once those objects exist.

import type { DashboardQuote } from './types';
import { deriveStatus } from '@/lib/quoteStatus';

/** A single status cell on the board: how many quotes and their total value. */
export type StageBucket = { count: number; totalUsd: number };

export type WorkflowBoard = {
  quotes: {
    draft: StageBucket;
    awaitingResponse: StageBucket;
    approved: StageBucket;
    booked: StageBucket;
  };
};

function emptyBucket(): StageBucket {
  return { count: 0, totalUsd: 0 };
}

export function computeWorkflowBoard(quotes: DashboardQuote[]): WorkflowBoard {
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

  return { quotes: { draft, awaitingResponse, approved, booked } };
}
