// Canonical quote lifecycle status model (ledger #83, Phase 1 foundation).
//
// The full QuoteStatus set is the locked spec contract (docs/jobber-flow/SPEC.md
// §3). Two entry points:
//   - deriveStatus(row): the read fallback + backfill source of truth. Prefers a
//     PERSISTED `status` for the states timestamps can't express (declined /
//     changes_requested / cancelled / abandoned), otherwise computes the latest state
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
  | 'abandoned';

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
  'abandoned',
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
 *      changes_requested, cancelled, abandoned — wins (a declined quote may still
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
  'abandoned',
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
 * #263: the ONE definition of "a legacy_rebook ('YLL Neighbor') quote that's
 * still a genuinely parked, unsent draft" — every surface that needs to
 * hide or bucket these (the inbox's listOpenItems/listEscalatableItems +
 * quotetool.ts's ingest guard, the text-ops bot's name search, the morning
 * digest's rebook line) routes through this so they can't drift into
 * disagreeing definitions again — the same drift class #252 slice G already
 * paid down once, when store.ts and quotetool.ts silently disagreed.
 *
 * Deliberately built on deriveStatus, NOT the raw persisted `status` column:
 *   - #267(b): a legacy_rebook row that's actually been PAID (deposit_paid_at
 *     set) derives 'booked' here even if its persisted status column never
 *     got written past 'draft' — so a row representing real money can never
 *     be suppressed to invisible. A raw `status === 'draft'` check can't see
 *     that; deriveStatus's own precedence (deposit_paid_at wins over a stale
 *     status string) closes the hole by construction.
 *   - matches every OTHER lifecycle read in the app — deriveStatus is already
 *     the canonical source of truth everywhere else (the admin list, the
 *     dashboard, the bot's own STATUS_LABELS) — a raw-status-based side
 *     channel here was exactly the kind of drift #263 flagged.
 *
 * `legacy_rebook` is checked with `=== true` (not merely truthy) so a
 * null/undefined read (a surface that doesn't select the column) defaults to
 * "not parked" rather than accidentally hiding a normal quote.
 */
export function isParkedLegacyRebookDraft(q: QuoteStatusRow & { legacy_rebook?: boolean | null }): boolean {
  return q.legacy_rebook === true && deriveStatus(q) === 'draft';
}

/**
 * Legal status transitions. The forward lifecycle is linear
 * (draft→sent→viewed→approved→booked); the portal branches (decline / request
 * changes) and the admin cancel/abandoned can fire from the pre-booked states.
 *
 *   draft             → sent · approved · cancelled · abandoned · declined   (approved from draft = offline close; declined = the customer said no before it was ever sent)
 *   sent              → viewed · approved · changes_requested · declined · cancelled · abandoned
 *   viewed            → approved · changes_requested · declined · cancelled · abandoned
 *   approved          → booked · cancelled · declined   (#124 — declined = customer backed out BEFORE paying the deposit; approved ⇒ no deposit, so it's money-safe)
 *   booked            → cancelled                     (a PAID deal is never "declined" — only cancelled, refunds manual)
 *   changes_requested → sent · declined · cancelled · abandoned   (staff edit → resend, or it falls through)
 *   declined          → (terminal)
 *   cancelled         → (terminal)
 *   abandoned         → (terminal)
 *
 * The `declined` targets (#124) stay money-safe by construction: `deriveStatus`
 * returns 'booked' the moment a deposit is paid, so any status still reading
 * 'draft'/'approved' provably has deposit_paid_at = NULL (no charge, no job). The
 * decline routes ALSO guard the DB write on `.is(deposit_paid_at, null)`, so a
 * quote that took a deposit can never be declined even under a race.
 *
 * Same-state "transitions" (from === to) are NOT legal here — callers gate real
 * state CHANGES; an idempotent no-op write is the caller's concern, not a
 * transition.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  draft: ['sent', 'approved', 'cancelled', 'abandoned', 'declined'],
  sent: ['viewed', 'approved', 'changes_requested', 'declined', 'cancelled', 'abandoned'],
  viewed: ['approved', 'changes_requested', 'declined', 'cancelled', 'abandoned'],
  approved: ['booked', 'cancelled', 'declined'],
  booked: ['cancelled'],
  changes_requested: ['sent', 'declined', 'cancelled', 'abandoned'],
  declined: [],
  cancelled: [],
  abandoned: [],
};

export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Ledger #116 (re-send half) — true for the two terminal statuses a dead
 * quote can be REVIVED from: 'declined' and 'abandoned'. Revive re-opens the SAME
 * quote to 'sent' (re-stamp, re-message, re-advance the GHL card) instead of
 * cloning a new draft (that's rebook, `rebookFromQuote`).
 *
 * Deliberately NOT modeled as a transition in ALLOWED_TRANSITIONS/canTransition
 * — that table is the general-purpose gate every staff-approve/decline route
 * shares, and widening it to allow declined/abandoned → sent would hand every one
 * of those consumers a move they were never designed for. The /send route
 * checks canRevive() directly as a narrow, scoped bypass instead.
 *
 * 'cancelled' is excluded on purpose: cancelled is post-booking (a deposit
 * was taken, then the job was cancelled) — a refund is a manual money
 * conversation, not something a quiet re-send should paper over. Cancelled
 * quotes stay rebook-only (a fresh draft, the original left intact).
 */
export function canRevive(status: QuoteStatus): boolean {
  return status === 'declined' || status === 'abandoned';
}

// Bug fix (B3 UI): the customer portal shows the approve + pay controls only
// while a quote is still live. A quote in a terminal branch (declined /
// cancelled / abandoned) is closed; one in changes_requested is being revised.
// In either case the customer must NOT be able to approve/pay — the server
// already rejects it (the /approve status gate + /pay's approve-first guard),
// this is the matching UI gate so they don't even SEE the controls.
//
// Takes a string so page/component code can pass PortalQuote.quoteStatus
// (typed as string) without a cast; an unknown/undefined value is treated as
// actionable (fail-open to the normal flow — the server is the real gate).
const NON_ACTIONABLE_PORTAL_STATUSES: ReadonlySet<string> = new Set([
  'declined',
  'cancelled',
  'abandoned',
  'changes_requested',
]);

export function isPortalActionable(status: string | null | undefined): boolean {
  return !status || !NON_ACTIONABLE_PORTAL_STATUSES.has(status);
}

/**
 * Ledger row 242 (Jason, 2026-08-11 decision, framing corrected by recon):
 * `'approved'` stays a real QuoteStatus union member — deriveStatus above
 * still synthesizes it from `customer_approved_at` whenever `deposit_paid_at`
 * is null, and it's a full member of ALLOWED_TRANSITIONS — but every quote-
 * lane surface that used to badge it as a standalone "Approved" pipeline
 * STAGE now shows this label instead, so the visible progression reads
 * sent -> viewed -> booked with no separate "Approved" milestone. The chosen
 * wording ("Awaiting Deposit") names what's actually still outstanding for
 * this derived state, rather than presenting the approval as a finish line —
 * a sent-but-unpaid approval is exactly that: awaiting the deposit.
 *
 * Single source so the admin quotes list, the quote detail page, and the
 * quote builder header pill can't drift into three different wordings for
 * the same derived state (they already had for `changes_requested` before
 * this — 'Changes' vs 'Changes requested' — a warning sign this scope
 * creates real drift risk without one shared string). Presentation only:
 * nothing here touches deriveStatus, canTransition, or any money-guard route
 * — those all key off the 'approved' CODE + the customer_approved_at
 * timestamp, both untouched by this label.
 */
export const APPROVED_STAGE_DISPLAY_LABEL = 'Awaiting Deposit';
