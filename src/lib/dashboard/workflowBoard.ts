// Workflow board — the Jobber-style pipeline view (ledger #82, Phase 2 start).
// Phase 1 slice: the QUOTES stage, bucketed by lifecycle status derived from
// the existing quote timestamps (same source the worklist uses). The Jobs and
// Invoices stages land in #82 Phase 2/3 once those objects exist.

import type { DashboardQuote } from './types';

/** Jobber-style quote pipeline statuses we can derive from timestamps today. */
export type QuoteStage = 'draft' | 'awaiting_response' | 'approved';

/** A single status cell on the board: how many quotes and their total value. */
export type StageBucket = { count: number; totalUsd: number };

export type WorkflowBoard = {
  quotes: {
    draft: StageBucket;
    awaitingResponse: StageBucket;
    approved: StageBucket;
  };
};

/** Latest pipeline stage of a quote. Approved wins (a won deal that was never
 *  formally "sent" still counts as approved, matching the worklist's rule). */
export function deriveQuoteStage(q: DashboardQuote): QuoteStage {
  if (q.customer_approved_at) return 'approved';
  if (q.quote_sent_at) return 'awaiting_response';
  return 'draft';
}

function emptyBucket(): StageBucket {
  return { count: 0, totalUsd: 0 };
}

export function computeWorkflowBoard(quotes: DashboardQuote[]): WorkflowBoard {
  const draft = emptyBucket();
  const awaitingResponse = emptyBucket();
  const approved = emptyBucket();
  const byStage: Record<QuoteStage, StageBucket> = {
    draft,
    awaiting_response: awaitingResponse,
    approved,
  };

  for (const q of quotes) {
    const bucket = byStage[deriveQuoteStage(q)];
    bucket.count += 1;
    bucket.totalUsd += q.total ?? 0;
  }

  return { quotes: { draft, awaitingResponse, approved } };
}
