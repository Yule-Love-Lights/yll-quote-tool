// Needs-Action work queue — a single sorted list of items that need operator
// attention TODAY (follow-ups, uncollected deposits, uncollected balances).
//
// PURE — no IO. Accept `nowMs` so callers can inject a fixed timestamp for
// deterministic testing (never call Date.now() inside this module).

import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import type { DashboardQuote } from './types';

// ─── Public types ────────────────────────────────────────────────────────────

/** The three action buckets, in priority order (sorted most-urgent first). */
export type NeedsActionKind =
  | 'nudge'            // follow up on a sent/viewed quote ≥ 3 days old
  | 'collect-deposit'  // approved, deposit not yet collected, ≥ 2 days
  | 'collect-balance'; // job at requires_invoicing + unpaid invoice ≥ 2 days

export type NeedsActionItem = {
  kind: NeedsActionKind;
  quoteId: string;
  /** Short display label — customer name + brief context. */
  label: string;
  /** One-line detail — age + next step. */
  detail: string;
  ageDays: number;
  /** Route the operator should land on for this action. */
  href: string;
};

/** The minimal job shape needed for the queue. */
export type NeedsActionJob = {
  id: string;
  quote_id: string | null;
  status: string;
  created_at: string;
};

/** The minimal invoice shape needed for the queue. */
export type NeedsActionInvoice = {
  id: string;
  job_id: string | null;
  quote_id: string | null;
  status: string;
  balance: number;
  created_at: string;
};

/** Everything `buildNeedsAction` needs — no DB calls inside the fn. */
export type NeedsActionInput = {
  nowMs: number;
  quotes: (DashboardQuote & { is_test?: boolean | null })[];
  jobs: NeedsActionJob[];
  invoices: NeedsActionInvoice[];
};

// ─── Constants ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** A sent/viewed quote that hasn't been approved in this many days → nudge. */
const NUDGE_THRESHOLD_DAYS = 3;

/** An approved-but-unbooked quote in this many days → collect-deposit nag. */
const DEPOSIT_THRESHOLD_DAYS = 2;

/** An invoice sitting unpaid for this many days → collect-balance nag. */
const BALANCE_THRESHOLD_DAYS = 2;

/** Terminal quote statuses that must never appear in any action bucket. */
const TERMINAL_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  'declined',
  'cancelled',
  'lost',
  'changes_requested',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function customerLabel(q: DashboardQuote): string {
  return q.customer_name?.trim() || 'Unknown customer';
}

function ageDaysFrom(isoTs: string, nowMs: number): number {
  return (nowMs - new Date(isoTs).getTime()) / MS_PER_DAY;
}

function floorDays(ageDays: number): number {
  return Math.floor(ageDays);
}

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

function formatUsd(cents: number): string {
  // balance is stored as dollars (not cents) in the DB — just format it.
  return `$${Math.round(cents).toLocaleString('en-US')}`;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Build the "Needs Action" list from pre-loaded dashboard data.
 * Returns items sorted most-urgent first (oldest ageDays first).
 *
 * PURE — no side-effects, no Date.now() calls.
 */
export function buildNeedsAction(input: NeedsActionInput): NeedsActionItem[] {
  const { nowMs, quotes, jobs, invoices } = input;
  const items: NeedsActionItem[] = [];

  // Index invoices by job_id so the job loop can look them up in O(1).
  const invoiceByJob = new Map<string, NeedsActionInvoice>();
  for (const inv of invoices) {
    if (inv.job_id) invoiceByJob.set(inv.job_id, inv);
  }

  // Index jobs by quote_id so the quote loop can look them up in O(1).
  const jobByQuote = new Map<string, NeedsActionJob>();
  for (const j of jobs) {
    if (j.quote_id) jobByQuote.set(j.quote_id, j);
  }

  for (const q of quotes) {
    // Test-quote isolation (mirrors workflowBoard.ts + queries.ts pattern).
    // DashboardQuote doesn't carry is_test (the query excludes is_test=true at
    // source), but the input type allows it for callers that pass full rows.
    if ((q as { is_test?: boolean | null }).is_test) continue;

    const status = deriveStatus(q);

    // Terminal statuses are never actionable.
    if (TERMINAL_STATUSES.has(status)) continue;

    // ── Bucket 1: nudge ─────────────────────────────────────────────────────
    // sent or viewed (not yet approved), quote_sent_at ≥ NUDGE_THRESHOLD_DAYS.
    if ((status === 'sent' || status === 'viewed') && q.quote_sent_at) {
      const ageDays = ageDaysFrom(q.quote_sent_at, nowMs);
      if (ageDays >= NUDGE_THRESHOLD_DAYS) {
        const floor = floorDays(ageDays);
        items.push({
          kind: 'nudge',
          quoteId: q.id,
          label: customerLabel(q),
          detail: `Sent ${pluralDays(floor)} ago — follow up`,
          ageDays,
          href: `/portal/${q.id}`,
        });
      }
      continue;
    }

    // ── Bucket 2: collect-deposit ────────────────────────────────────────────
    // approved (customer_approved_at set), deposit not yet paid,
    // ≥ DEPOSIT_THRESHOLD_DAYS since approval.
    if (status === 'approved' && q.customer_approved_at && !q.deposit_paid_at) {
      const ageDays = ageDaysFrom(q.customer_approved_at, nowMs);
      if (ageDays >= DEPOSIT_THRESHOLD_DAYS) {
        const floor = floorDays(ageDays);
        items.push({
          kind: 'collect-deposit',
          quoteId: q.id,
          label: customerLabel(q),
          detail: `Approved ${pluralDays(floor)} ago — collect deposit`,
          ageDays,
          href: `/quote/${q.id}`,
        });
      }
      continue;
    }

    // ── Bucket 3: collect-balance ────────────────────────────────────────────
    // A job at requires_invoicing with an unpaid (draft | awaiting_payment)
    // invoice, invoice ≥ BALANCE_THRESHOLD_DAYS old.
    const job = jobByQuote.get(q.id);
    if (job && job.status === 'requires_invoicing') {
      const inv = invoiceByJob.get(job.id);
      if (inv && (inv.status === 'draft' || inv.status === 'awaiting_payment') && inv.balance > 0) {
        const ageDays = ageDaysFrom(inv.created_at, nowMs);
        if (ageDays >= BALANCE_THRESHOLD_DAYS) {
          const floor = floorDays(ageDays);
          items.push({
            kind: 'collect-balance',
            quoteId: q.id,
            label: customerLabel(q),
            detail: `Invoice ${pluralDays(floor)} old — collect balance ${formatUsd(inv.balance)}`,
            ageDays,
            href: `/admin/invoices/${inv.id}`,
          });
        }
      }
    }
  }

  // Most urgent (oldest ageDays) first.
  items.sort((a, b) => b.ageDays - a.ageDays);
  return items;
}
