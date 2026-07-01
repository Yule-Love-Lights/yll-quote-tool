// Canonical quote lifecycle status model (ledger #83, Phase 1 foundation).
//
// The full QuoteStatus set is the locked spec contract (docs/jobber-flow/SPEC.md
// §3). Two entry points:
//   - deriveStatus(row): the read fallback + backfill source of truth. Prefers a
//     PERSISTED `status` for the states timestamps can't express (declined /
//     changes_requested / cancelled / lost), otherwise computes the latest state
//     reachable from the existing lifecycle timestamps (the only signal legacy
//     rows + pre-migration prod carry).
//   - canTransition(from, to): the legal-transitions table the write paths gate
//     on (Slice B routes + the migration's allowed states).
//
// Pure — no IO. Imported by the dashboard Workflow board, the admin quotes list,
// and (Slice B) the decline / request-changes routes.

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

/** Every status, for validation (e.g. "is this persisted value a known status?"). */
export const QUOTE_STATUSES: readonly QuoteStatus[] = [
  'draft',
  'sent',
  'viewed',
  'approved',
  'booked',
  'changes_requested',
  'declined',
  'cancelled',
  'lost',
] as const;

export function isQuoteStatus(v: unknown): v is QuoteStatus {
  return typeof v === 'string' && (QUOTE_STATUSES as readonly string[]).includes(v);
}

/**
 * The row shape `deriveStatus` reads. The three lifecycle timestamps are the
 * signal legacy rows carry; `viewed_at` (the #68 view receipt) and the persisted
 * `status` are optional so this stays callable from surfaces that don't select
 * them (the Workflow board's DashboardQuote, the pre-migration read paths) and
 * from the existing timestamp-only tests.
 */
export type QuoteStatusRow = {
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  // #68 view receipt — set when the customer first opened the portal link. Lets
  // a sent-but-unopened quote read 'sent' and an opened one read 'viewed', the
  // same split the admin list shows.
  viewed_at?: string | null;
  // The persisted Phase-1 status column (null on legacy / pre-migration rows).
  // Authoritative when it holds a state timestamps can't express.
  status?: QuoteStatus | null;
};

// Backward-compatible alias — the original Phase-1-foundation name. Kept so
// existing imports (`type QuoteLifecycleTimestamps`) keep resolving.
export type QuoteLifecycleTimestamps = QuoteStatusRow;

/**
 * The latest status for a row. Precedence:
 *   1. A PERSISTED `status` that timestamps can't represent — declined,
 *      changes_requested, cancelled, lost — wins (a declined quote may still
 *      carry quote_sent_at/viewed_at, but its real state is "declined").
 *   2. Otherwise derive from timestamps, later stage winning:
 *      booked > approved > viewed > sent > draft. The "later stage wins" rule
 *      mirrors the worklist: an offline-closed deal that never had quote_sent_at
 *      stamped still reads approved/booked.
 *
 * A persisted draft/sent/viewed/approved/booked is intentionally NOT trusted
 * over the timestamps — those forward states are always re-derivable, and the
 * timestamp is the more authoritative record (e.g. the deposit webhook is the
 * source of truth for "booked", not a status write that may lag).
 */
const TERMINAL_OR_BRANCH: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  'changes_requested',
  'declined',
  'cancelled',
  'lost',
]);

export function deriveStatus(q: QuoteStatusRow): QuoteStatus {
  if (q.status && TERMINAL_OR_BRANCH.has(q.status)) return q.status;
  if (q.deposit_paid_at) return 'booked';
  if (q.customer_approved_at) return 'approved';
  if (q.viewed_at) return 'viewed';
  if (q.quote_sent_at) return 'sent';
  return 'draft';
}

/**
 * Legal status transitions. The forward lifecycle is linear
 * (draft→sent→viewed→approved→booked); the portal branches (decline / request
 * changes) and the admin cancel/lost can fire from the pre-booked states.
 *
 *   draft             → sent · approved · cancelled · lost   (approved from draft = deliberate offline/in-person close)
 *   sent              → viewed · approved · changes_requested · declined · cancelled · lost
 *   viewed            → approved · changes_requested · declined · cancelled · lost
 *   approved          → booked · cancelled            (post-approval signed; only booking or cancel)
 *   booked            → cancelled                     (a paid deal can only be cancelled — refunds manual)
 *   changes_requested → sent · declined · cancelled · lost   (staff edit → resend, or it falls through)
 *   declined          → (terminal)
 *   cancelled         → (terminal)
 *   lost              → (terminal)
 *
 * Same-state "transitions" (from === to) are NOT legal here — callers gate real
 * state CHANGES; an idempotent no-op write is the caller's concern, not a
 * transition.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  draft: ['sent', 'approved', 'cancelled', 'lost'],
  sent: ['viewed', 'approved', 'changes_requested', 'declined', 'cancelled', 'lost'],
  viewed: ['approved', 'changes_requested', 'declined', 'cancelled', 'lost'],
  approved: ['booked', 'cancelled'],
  booked: ['cancelled'],
  changes_requested: ['sent', 'declined', 'cancelled', 'lost'],
  declined: [],
  cancelled: [],
  lost: [],
};

export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
