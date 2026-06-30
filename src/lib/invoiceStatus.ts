// Canonical invoice lifecycle status model (ledger #83, Phase 3).
//
// SPEC §3: an invoice is auto-created `draft` at install-complete, moves to
// `awaiting_payment` (or straight to `paid` when the balance is collected), and
// ends `paid`. `cancelled` is a terminal off-ramp reachable from any state —
// including `paid`, since a post-payment cancel means a MANUAL Valor refund
// (no refund integration; mirrors the Phase 4 / cancellation decision). There is
// no past-due/aging state — Naldo opted out of AR tracking.
//
// Pure module (no Supabase) so the data layer and any UI can import it. Mirrors
// src/lib/jobStatus.ts.

export type InvoiceStatus = 'draft' | 'awaiting_payment' | 'paid' | 'cancelled';

/** The canonical set, in lifecycle order (cancelled last as the off-ramp). */
export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'draft',
  'awaiting_payment',
  'paid',
  'cancelled',
] as const;

// Legal forward transitions. An invoice can be paid directly from draft (the
// auto-charge succeeds on creation) or after awaiting_payment (the pay-link is
// paid). A PAID invoice can REOPEN to awaiting_payment when a booked order is
// amended UP or a tax-exemption is restored (more becomes owed — #83 re-sync).
// Cancel is reachable from every non-cancelled state (a paid invoice can be
// cancelled → manual refund). `cancelled` is terminal.
const TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['awaiting_payment', 'paid', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['awaiting_payment', 'cancelled'],
  cancelled: [],
};

/** Whether `to` is a legal next status from `from`. */
export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Narrow an unknown value to an InvoiceStatus, or null if it isn't one. */
export function asInvoiceStatus(v: unknown): InvoiceStatus | null {
  return typeof v === 'string' && (INVOICE_STATUSES as readonly string[]).includes(v)
    ? (v as InvoiceStatus)
    : null;
}
