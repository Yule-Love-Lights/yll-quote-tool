// Canonical quote lifecycle status model (ledger #83, Phase 1 foundation).
//
// The full QuoteStatus set is the locked spec contract (docs/jobber-flow/SPEC.md
// §3). `deriveStatus` computes the subset reachable from the existing lifecycle
// timestamps — used by surfaces that don't yet read a persisted `status` column
// (e.g. the dashboard Workflow board). The remaining statuses
// (viewed/changes_requested/declined/cancelled/lost) arrive with the Phase 1
// migration that persists `status` + `decline_reason` (Jason's area + #81).

export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'approved'
  | 'booked'
  | 'changes_requested'
  | 'declined'
  | 'cancelled'
  | 'lost';

/** The lifecycle timestamps `deriveStatus` reads. */
export type QuoteLifecycleTimestamps = {
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
};

/**
 * Latest status derivable from timestamps. Precedence: booked > approved > sent
 * > draft (the same "later stage wins" rule the worklist uses — a deal that was
 * closed offline without a send still reads as approved/booked).
 */
export function deriveStatus(q: QuoteLifecycleTimestamps): QuoteStatus {
  if (q.deposit_paid_at) return 'booked';
  if (q.customer_approved_at) return 'approved';
  if (q.quote_sent_at) return 'sent';
  return 'draft';
}
