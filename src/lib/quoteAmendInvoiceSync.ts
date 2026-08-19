// Shared invoice re-sync for a booked order's amendment trail (ledger #83
// decline follow-up, review HIGH). Both /amend (staff records a re-price) and
// /amend-decline (customer refuses one) need the SAME re-sync: bring the
// linked invoice's total/balance/status back into agreement with the
// now-effective agreed total, so the balance an operator collects always
// matches what the customer actually owes. Before this fix, /amend-decline
// wrote ONLY approval_snapshot — on an already-invoiced order, a decline left
// the invoice frozen at the rejected figures, and an operator override on the
// collection routes could then charge exactly the amount the customer refused.
//
// Extracted out of amend/route.ts's own re-sync block — the body below is
// that ORIGINAL logic, unchanged, just parameterized on which route is
// calling (logPrefix, for log provenance) and why a reopen retires its txn
// (retiredReason, so the audit trail can tell a re-price reopen from a
// decline reopen apart). amend/route.ts's own observable behavior is
// unchanged by this extraction — see its test suite, still green.
//
// Deliberately a STANDALONE module, not a member of invoices.ts: its calls to
// getInvoiceByJob/appendRetiredTxn must go through the SAME cross-module
// import boundary amend/route.ts already calls them through, so
// vi.mock('@/lib/invoices', ...) in each route's test file can still
// intercept them. A same-file call from inside invoices.ts would bypass that
// mock — Vitest replaces the module namespace object seen by EXTERNAL
// importers, not a function's own same-file identifier references — and
// would silently start hitting the real DB-backed helpers under test.

import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  computeInvoiceTotals,
  getInvoiceByJob,
  appendRetiredTxn,
  type InvoiceRow,
  type InvoicePricingInput,
} from '@/lib/invoices';
import { canTransition, type InvoiceStatus } from '@/lib/invoiceStatus';
import { roundMoney as round2 } from '@/lib/money';

export type InvoiceResyncOutcome = {
  invoicedBalance: number | null;
  invoicedTotal: number | null;
  // FIX4 (review HIGH, money): the invoice's total immediately BEFORE this
  // re-sync overwrote it (from the fresh re-read) — null whenever
  // invoicedTotal is null (the resync never reached a successful write). Lets
  // a caller derive an invoice-basis DELTA (invoicedTotal − previousInvoicedTotal)
  // that reconciles with invoicedTotal on the SAME basis, instead of pairing an
  // invoice-basis total with the trail's tax-inclusive delta — the two can
  // disagree by the whole tax line on a tax-overridden invoice.
  previousInvoicedTotal: number | null;
};

export type ResyncInvoiceArgs = {
  // The job the invoice belongs to — used only for the B10 re-read below. null
  // mirrors the original `job ? await getInvoiceByJob(job.id) : null` guard
  // (defensive: the caller's own `invoice` non-null-ness doesn't let TS infer
  // `job` is non-null too).
  jobId: string | null;
  // The already-known invoice — caller has already checked it's non-null and
  // (per its own read) not cancelled; this function re-checks after the fresh
  // re-read below (same double-check the original code had).
  invoice: InvoiceRow;
  // The quote's FULL pricing result (quote.result) — the un-overridden
  // breakdown the tax-scaling formula needs.
  result: InvoicePricingInput & { total: number };
  depositPaid: number;
  // The new AGREED total (dollars) to re-sync the invoice to.
  newTotal: number;
  // Route-specific log tag, e.g. '[api/quotes/:id/amend]' / '[api/quotes/:id/amend-decline]'.
  logPrefix: string;
  // appendRetiredTxn's `reason` field — lets a reopened txn's audit trail say
  // WHY (a staff re-price vs a customer decline reverting one).
  retiredReason: string;
};

/**
 * Re-sync a linked invoice's total/balance/status to a new agreed total.
 * Best-effort: any failure (a DB error, an illegal status transition) is
 * logged and returns nulls — the caller's own already-recorded change (the
 * amendment trail entry, or the decline) is never undone by a sync failure.
 */
export async function resyncInvoiceToAgreedTotal(args: ResyncInvoiceArgs): Promise<InvoiceResyncOutcome> {
  const { jobId, invoice, result, depositPaid, newTotal, logPrefix, retiredReason } = args;
  const outcome: InvoiceResyncOutcome = {
    invoicedBalance: null,
    invoicedTotal: null,
    previousInvoicedTotal: null,
  };

  // B10 fix (re-read): re-fetch the invoice immediately before the status
  // decision + write to reduce the clobber window. A concurrent balance-webhook
  // or mark-paid between the earlier read and this write could flip the invoice
  // to 'paid'; without a re-read, the stale 'draft'/'awaiting_payment' status
  // would overwrite that settlement. The re-read narrows (but cannot eliminate)
  // that race; a fully atomic approach would require a Postgres RPC.
  const freshInvoice = jobId ? await getInvoiceByJob(jobId) : null;
  const invoiceForSync = freshInvoice ?? invoice;

  if (invoiceForSync.status === 'cancelled') {
    return outcome; // don't resurrect a cancelled invoice
  }

  // W1-004: re-sync to the AGREED new total (on the selection basis), not the
  // full quote.result.total — the breakdown lines stay from result for display,
  // the load-bearing total/balance use newTotal (same as the amendment trail).
  //
  // #125-1: one of several invoice write-paths (createInvoiceFromJob,
  // setInvoiceTaxOverride, this one). When tax is overridden,
  // computeInvoiceTotals subtracts pricing.taxAmount from the total — so the
  // whole-quote tax against a partial/amended newTotal would OVER-remove and
  // UNDER-BILL. Scale the removable tax to the amended basis (exact under the
  // flat rate: newTotal = taxable × (1+rate) ⇒ newTotal/fullTotal = taxable
  // ratio), mirroring the other write paths.
  const fullTotal = result.total ?? 0;
  const scaledTax =
    fullTotal > 0 ? round2((result.taxAmount ?? 0) * (newTotal / fullTotal)) : (result.taxAmount ?? 0);
  const totals = computeInvoiceTotals(
    { ...result, taxAmount: scaledTax, total: newTotal },
    depositPaid,
    { taxOverridden: invoiceForSync.tax_overridden },
  );
  // Reconcile the invoice STATUS to the new balance (review MEDIUM): a
  // re-sync that raises the total on an already-paid invoice reopens it to
  // awaiting_payment (more is owed); a re-sync that lowers the total to what
  // the deposit already covers settles it to paid. A draft/awaiting invoice
  // with a remaining balance is left as-is.
  const reconciledStatus: InvoiceStatus =
    totals.balance <= 0
      ? 'paid'
      : invoiceForSync.status === 'paid'
        ? 'awaiting_payment'
        : invoiceForSync.status;

  // B10 fix (defense-in-depth guard): gate the bare status write through
  // canTransition. Every transition this re-sync actually performs is already
  // legal (draft/awaiting_payment→paid, paid→awaiting_payment, and the no-op
  // self-transitions all live in invoiceStatus.ts's TRANSITIONS table), so
  // this never blocks a real re-sync — it's a belt-and-suspenders check that
  // catches a future illegal transition (e.g. resurrecting a cancelled
  // invoice) instead of writing it blindly. A self-transition (status
  // unchanged) is permitted so we still re-sync the money fields.
  if (reconciledStatus !== invoiceForSync.status && !canTransition(invoiceForSync.status, reconciledStatus)) {
    console.error(
      `${logPrefix} illegal invoice transition ${invoiceForSync.status} → ${reconciledStatus} (invoice ${invoiceForSync.id}) — skipping re-sync`,
    );
    return outcome;
  }

  // B10 fix (paid_at): maintain paid_at to match the reconciled status. Stamp
  // on settle-to-paid; clear on reopen.
  const paidAtPatch: Record<string, unknown> = {};
  if (reconciledStatus === 'paid' && invoiceForSync.status !== 'paid') {
    paidAtPatch.paid_at = new Date().toISOString();
  } else if (reconciledStatus === 'awaiting_payment' && invoiceForSync.status === 'paid') {
    paidAtPatch.paid_at = null;
  }

  const sb = getSupabaseServiceClient()!;
  const { error: invErr } = await sb
    .from('invoices')
    .update({
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      total: totals.total,
      deposit_applied: totals.deposit_applied,
      balance: totals.balance,
      credit_note: totals.credit_note,
      status: reconciledStatus,
      ...paidAtPatch,
    })
    .eq('id', invoiceForSync.id);
  if (invErr) {
    // The amendment/decline is already recorded; an invoice-sync failure is
    // reconcilable (re-run it / edit the invoice manually). Surface it.
    // invoicedBalance/invoicedTotal deliberately stay null: the row still
    // holds its PRE-resync figures, so neither number is the billed one.
    console.error(`${logPrefix} invoice re-sync failed:`, invErr);
    return outcome;
  }
  outcome.invoicedBalance = totals.balance;
  // Same reasoning as invoicedBalance: on a tax-overridden invoice the
  // invoice TOTAL is newTotal minus the scaled tax, so quoting the trail's
  // own total would disagree with the invoice too.
  outcome.invoicedTotal = totals.total;
  // FIX4: the PRE-resync invoice total (from the fresh re-read above), on the
  // SAME invoice basis as outcome.invoicedTotal — a caller can subtract to get
  // an internally-consistent delta.
  outcome.previousInvoicedTotal = invoiceForSync.total;

  // #170(b): reopening a PAID invoice starts a NEW charge cycle — retire the
  // settled txn to valor_txn_log and clear the live slot, or the next card
  // charge 409s 'already-charged' against LAST cycle's txn (the misleading
  // dead-end) and a new payment would clobber the old record. Runs through the
  // CAS'd appendRetiredTxn AFTER the money re-sync (#640 review MED: a plain
  // composite read-modify-write could lose a concurrent double-charge stash
  // entry). The tiny window where the new balance coexists with the old txn id
  // fails CLOSED — a charge in that instant 409s 'already-charged'. A pending
  // sentinel can't be on a paid invoice; guarded anyway so a rotation can never
  // eat a live claim.
  //
  // This fires for a DECLINE too, not only a staff re-price: declining a
  // price DECREASE (requiresReconsent covers both directions) reverts the
  // agreed total back UP to the prior figure, which can reopen an
  // already-settled invoice exactly the same way an amend-up does.
  if (
    reconciledStatus === 'awaiting_payment' &&
    invoiceForSync.status === 'paid' &&
    invoiceForSync.valor_balance_txn_id &&
    !invoiceForSync.valor_balance_txn_id.startsWith('pending:')
  ) {
    await appendRetiredTxn(
      invoiceForSync.id,
      {
        txnId: invoiceForSync.valor_balance_txn_id,
        receiptUrl: invoiceForSync.valor_receipt_url,
        settledAt: invoiceForSync.paid_at,
        retiredAt: new Date().toISOString(),
        reason: retiredReason,
      },
      { clearLive: { expectTxnId: invoiceForSync.valor_balance_txn_id } },
    );
  }

  return outcome;
}
