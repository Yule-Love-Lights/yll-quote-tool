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
  type InvoiceTotals,
} from '@/lib/invoices';
import { canTransition, type InvoiceStatus } from '@/lib/invoiceStatus';
import { roundMoney as round2 } from '@/lib/money';

// Row 341 fix round 2 (technical-lens HIGH, real, re-derived independently):
// how much has ACTUALLY been collected on an invoice BEYOND the immutable
// deposit — a settled balance payment on the row being reopened. `balance =
// total − deposit_applied` (computeInvoiceTotals' formula) is only correct
// while nothing but the deposit has ever been collected; once a REAL balance
// payment has landed (the Valor balance webhook settling it, a manual
// mark-paid, cash), invoice.balance drops to 0 while total stays put, and
// `total − balance` stops equalling `deposit_applied` alone — the gap IS
// money genuinely already in hand that a re-price must not re-demand.
// `total − balance` is the general invariant: on an untouched invoice it
// equals deposit_applied (nothing extra collected, gap = 0); on a settled
// one it equals the full total (everything collected). Subtracting
// deposit_applied from that gives exactly the EXTRA amount, independent of
// status. Defensive: returns 0 (the pre-fix, safe no-op) unless total,
// balance, AND deposit_applied are all present finite numbers — a caller
// with a partial/legacy row must never derive a fabricated "extra collected"
// figure from missing data (see the call sites' own comments).
export function priorBalanceCollectedUsd(invoiceRow: {
  total?: number | null;
  balance?: number | null;
  deposit_applied?: number | null;
}): number {
  const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const total = finite(invoiceRow.total);
  const balance = finite(invoiceRow.balance);
  const depositApplied = finite(invoiceRow.deposit_applied);
  if (total === null || balance === null || depositApplied === null) return 0;
  return round2(Math.max(0, total - balance - depositApplied));
}

// Row 395 fix (two independent review lenses, HIGH): moved here from
// src/app/admin/invoices/[id]/page.tsx, where it rendered UNCONDITIONALLY on
// every invoice with `priorBalanceCollectedUsd(inv) > 0` — which is the
// NORMAL state of any fully-paid invoice (once balance hits 0, `total −
// balance` stops equalling deposit_applied alone by construction; see that
// function's own comment). Confirmed against all four real prod invoices —
// all four permanently paid, all four would show it forever. A caution that
// fires on 100% of settled invoices trains staff to ignore every amber box
// on the page.
//
// Jason's ruling (row 395): relocate to the point of USE — the "Record
// amendment" panel on /admin/jobs/[id], the only screen where this
// inference actually drives money (computeInvoiceResyncTotals' balance math
// on a re-price) — and remove the invoice detail page's copy entirely.
// Same formula/copy as the removed version, just re-homed; kept a pure text
// builder (no IO) so it stays trivially unit-testable without jsdom, which
// this repo doesn't have.
export function priorCollectedWarning(inv: {
  total?: number | null;
  balance?: number | null;
  deposit_applied?: number | null;
}): string | null {
  const collected = priorBalanceCollectedUsd(inv);
  if (collected <= 0) return null;
  const collectedUsd = `$${collected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    `Invoice math assumes ${collectedUsd} has already been collected beyond the deposit. ` +
    `If a refund was issued manually in Valor against this invoice, that figure — and the balance this ` +
    `amendment computes — may be wrong. Verify in Valor before relying on it.`
  );
}

// Row 389 (S, admin lens MED): a quote's approval_snapshot carries a durable
// marker whenever this repo already KNOWS its linked invoice's total/balance
// is provisional — either a customer charge was refused because the invoice
// didn't match the agreed total (`paymentBlocked`, written by pay-balance/
// route.ts) or a staff-side re-sync itself failed to land
// (`invoiceResyncFailed`, written by flagInvoiceResyncFailed below). Row 378
// and row 341 deliberately FREEZE both cases rather than correcting them —
// money must not move on a number we cannot stand behind — but a report
// (workflowBoard.ts's Invoices column, needsAction.ts's collect-balance nag)
// that keeps summing/quoting the frozen figure with no indicator is exactly
// the gap this row named. Pure, no IO — the ONE place both dashboard call
// sites import this from, so the two marker names can't drift apart between
// them (the same reasoning FIX A gives for a shared money formula, applied to
// a shared STALENESS check instead).
export function isStaleInvoiceSnapshot(
  approvalSnapshot: { paymentBlocked?: unknown; invoiceResyncFailed?: unknown } | null | undefined,
): boolean {
  return !!(approvalSnapshot?.paymentBlocked || approvalSnapshot?.invoiceResyncFailed);
}

// FIX A (delta-verify HIGH, fix round 4): the exact money formula
// resyncInvoiceToAgreedTotal uses to re-price the invoice — pulled out so the
// amend route can compute the SAME figures BEFORE it persists the amendment
// trail entry (see that route's pre-write invoice_basis stamp), instead of
// duplicating the scaled-tax formula in a second place where it could drift.
// Pure — no IO. Takes the tax_overridden flag directly (not an InvoiceRow)
// so a caller that hasn't fetched the row yet (or has only a partial one)
// can still call it.
export function computeInvoiceResyncTotals(
  result: InvoicePricingInput & { total: number },
  depositPaidUsd: number,
  newTotal: number,
  taxOverridden: boolean,
  // Row 341 fix round 2 (technical-lens HIGH): money ALREADY collected
  // beyond the deposit — pass priorBalanceCollectedUsd(freshInvoiceRow).
  // Optional, defaults to 0 (the pre-fix, still-correct behavior for the
  // common case: nothing beyond the deposit has ever been collected), so
  // every call site/test written before this parameter existed is
  // unaffected. Every REAL call site (resyncInvoiceToAgreedTotal's own
  // write, amend/route.ts's pre-write basis stamp, charge-balance's
  // reconciliation guard) now passes it, so all three agree BY
  // CONSTRUCTION — one formula, not three independent re-derivations.
  priorBalanceCollectedUsd = 0,
): InvoiceTotals {
  // #125-1: when tax is overridden, computeInvoiceTotals subtracts
  // pricing.taxAmount from the total — so the whole-quote tax against a
  // partial/amended newTotal would OVER-remove and UNDER-BILL. Scale the
  // removable tax to the amended basis (exact under the flat rate: newTotal
  // = taxable × (1+rate) ⇒ newTotal/fullTotal = taxable ratio).
  const fullTotal = result.total ?? 0;
  const scaledTax =
    fullTotal > 0 ? round2((result.taxAmount ?? 0) * (newTotal / fullTotal)) : (result.taxAmount ?? 0);
  const base = computeInvoiceTotals(
    { ...result, taxAmount: scaledTax, total: newTotal },
    depositPaidUsd,
    { taxOverridden },
  );
  if (priorBalanceCollectedUsd <= 0) return base;
  // Extra money collected beyond the deposit reduces balance/credit_note
  // FURTHER — `deposit_applied` itself is left UNTOUCHED. It is not a
  // generic "amount applied" bucket: it is displayed to customers, verbatim,
  // as literally "the deposit" (the invoice PDF's "Deposit collected" line,
  // docModels.ts; the admin invoice/job/quote pages' "−{deposit_applied}"
  // line item; the portal's receipt-availability gate). Lumping a
  // previously-collected BALANCE payment into that field would misreport a
  // real transaction as part of the deposit on every receipt this invoice
  // ever produces going forward.
  const totalApplied = round2(base.deposit_applied + priorBalanceCollectedUsd);
  const balance = round2(Math.max(0, base.total - totalApplied));
  const credit_note = round2(Math.max(0, totalApplied - base.total));
  return { ...base, balance, credit_note };
}

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
  // Row 341 (staff-lens HIGH, fix round): true ONLY when the invoices row was
  // actually written to these figures — including a successful retry after a
  // lost CAS race (see the retry loop below). False for EVERY skip/failure
  // path (a cancelled invoice, an illegal status transition, a DB error, or a
  // race that was still lost after the one retry) — invoicedTotal/
  // invoicedBalance are null in every one of those cases too, but `resynced`
  // is the field a caller should branch on: it says plainly "the invoice was
  // NOT updated to match what was just recorded/reported", instead of a
  // caller re-deriving that from a null check that also (harmlessly) fires
  // for the cancelled-invoice skip. Before this field existed, BOTH callers
  // (amend/route.ts, amend-decline/route.ts) discarded this function's
  // return value entirely and reported success unconditionally — see each
  // route's own comment at its call site.
  resynced: boolean;
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
 * Best-effort: any failure (a DB error, an illegal status transition, or a
 * lost CAS race that the one retry below can't recover) is logged and
 * returns nulls with `resynced: false` — the caller's own already-recorded
 * change (the amendment trail entry, or the decline) is never undone by a
 * sync failure, but the caller can and must tell a human the invoice itself
 * was NOT updated to match.
 */
export async function resyncInvoiceToAgreedTotal(args: ResyncInvoiceArgs): Promise<InvoiceResyncOutcome> {
  const { jobId, invoice, result, depositPaid, newTotal, logPrefix, retiredReason } = args;
  const outcome: InvoiceResyncOutcome = {
    invoicedBalance: null,
    invoicedTotal: null,
    previousInvoicedTotal: null,
    resynced: false,
  };

  // B10 fix (re-read): re-fetch the invoice immediately before the status
  // decision + write to reduce the clobber window. A concurrent balance-webhook
  // or mark-paid between the earlier read and this write could flip the invoice
  // to 'paid'; without a re-read, the stale 'draft'/'awaiting_payment' status
  // would overwrite that settlement. The re-read narrows (but cannot eliminate)
  // that race; a fully atomic approach would require a Postgres RPC.
  const freshInvoice = jobId ? await getInvoiceByJob(jobId) : null;
  let invoiceForSync = freshInvoice ?? invoice;

  // Row 341 (staff-lens HIGH, this fix round): up to two attempts total. The
  // write below can lose its `updated_at` CAS — but per the corrected Row 339
  // comment inside the loop, the realistic other writer is NOT another
  // amendment request: /amend and /amend-decline both serialize on a whole-
  // `approval_snapshot` CAS one level up (each route's own snapshot write,
  // committed before this function is ever called), so two amendment
  // requests for the SAME quote can't both reach this function concurrently.
  // The write here instead races the Valor balance-settle webhook
  // (handleBalancePayment, src/app/api/integrations/valor/webhook/route.ts)
  // — it claims status/balance/paid_at/valor_balance_txn_id/valor_receipt_url
  // on whatever balance is already on the row, entirely independent of an
  // in-flight amendment, and that write still bumps `updated_at` (the same
  // trigger) even though it never touches total/tax/subtotal/discount/
  // deposit_applied/credit_note. One retry against a fresh re-read is enough
  // for that race: this function always RECOMPUTES totals + reconciledStatus
  // from whatever row it re-reads (below), so a retry naturally reopens an
  // invoice the webhook just settled at the stale (pre-amendment) balance
  // instead of silently leaving it 'paid' at a figure the customer no longer
  // owes.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Row 341 fix round 2 (LOW 4): deliberately NOT flagged, unlike every
    // other early return below. A cancelled invoice is the system working
    // AS DESIGNED — both callers already check `status !== 'cancelled'`
    // BEFORE ever calling this function, so reaching this branch means the
    // invoice was cancelled in the narrow gap between that check and this
    // re-read. Nothing is owed on a cancelled invoice and nothing should
    // ever collect against it; a marker here would read as "something needs
    // fixing" on a row that is exactly correct as left. Contrast the illegal-
    // transition and lost-race branches below, which DO flag — those are
    // genuine "we expected to sync and couldn't" outcomes.
    if (invoiceForSync.status === 'cancelled') {
      return outcome; // don't resurrect a cancelled invoice
    }

    // W1-004: re-sync to the AGREED new total (on the selection basis), not the
    // full quote.result.total — the breakdown lines stay from result for display,
    // the load-bearing total/balance use newTotal (same as the amendment trail).
    // FIX A: the scaled-tax + computeInvoiceTotals formula now lives in ONE
    // place (computeInvoiceResyncTotals, above) — the amend route's pre-write
    // invoice_basis stamp calls the exact same function on the exact same
    // inputs, so the two can't silently diverge into two different numbers.
    // Row 341 fix round 2 (technical-lens HIGH): pass priorBalanceCollectedUsd
    // derived from THIS iteration's freshly re-read `invoiceForSync` — a
    // balance payment the Valor webhook (or a manual mark-paid) settled since
    // the original deposit is real money already in hand, and the retry path
    // below reaches exactly that state (the webhook settles the stale
    // balance in the gap between attempts). Recomputed every iteration so a
    // retry's totals reflect the row it ACTUALLY re-read, not the first
    // attempt's now-stale figure.
    const totals = computeInvoiceResyncTotals(
      result,
      depositPaid,
      newTotal,
      invoiceForSync.tax_overridden,
      priorBalanceCollectedUsd(invoiceForSync),
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
      // Row 341 fix round 2 (LOW 4): flagged, unlike the cancelled-invoice
      // exit above — this is a genuine "expected to sync, couldn't" outcome
      // (a should-never-happen guard actually firing), not correct-as-
      // designed behavior.
      await flagInvoiceResyncFailed(invoiceForSync, totals, logPrefix);
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

    // Row 339 (LOW, #830/#862 shape): the B10 re-read above narrows the window
    // between reading the invoice and writing it, but — per that comment —
    // does not eliminate it: a write can still land in the gap between the
    // re-read and this write. CORRECTED attribution (row 341 fix round — the
    // original comment here blamed "two amendments close enough together";
    // that can't happen, see the comment above this loop for why): the
    // realistic other writer is the Valor balance-settle webhook. Without a
    // guard on the write itself, whichever write reaches Postgres LAST would
    // silently win regardless of which one is actually newer.
    // `.eq('updated_at', invoiceForSync.updated_at)` closes that: it's an
    // optimistic-lock filter on the exact row version this function just read,
    // not a heuristic — `invoices_updated_at_trigger` (FULL-SCHEMA.sql) stamps
    // `updated_at` on every write, so any write that lands in the gap changes
    // it and this filter then matches zero rows instead of overwriting.
    const sb = getSupabaseServiceClient()!;
    const { data: invRows, error: invErr } = await sb
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
      .eq('id', invoiceForSync.id)
      .eq('updated_at', invoiceForSync.updated_at)
      .select('id');
    if (invErr) {
      // The amendment/decline is already recorded; an invoice-sync failure is
      // reconcilable (re-run it / edit the invoice manually). Surface it.
      // invoicedBalance/invoicedTotal deliberately stay null: the row still
      // holds its PRE-resync figures, so neither number is the billed one.
      console.error(`${logPrefix} invoice re-sync failed:`, invErr);
      await flagInvoiceResyncFailed(invoiceForSync, totals, logPrefix);
      return outcome;
    }
    if (invRows && invRows.length > 0) {
      outcome.invoicedBalance = totals.balance;
      // Same reasoning as invoicedBalance: on a tax-overridden invoice the
      // invoice TOTAL is newTotal minus the scaled tax, so quoting the trail's
      // own total would disagree with the invoice too.
      outcome.invoicedTotal = totals.total;
      // FIX4: the PRE-resync invoice total (from the fresh re-read above), on the
      // SAME invoice basis as outcome.invoicedTotal — a caller can subtract to get
      // an internally-consistent delta.
      outcome.previousInvoicedTotal = invoiceForSync.total;
      // Row 341: the write actually landed (first try, or after the retry
      // below) — the ONLY case where a caller may report the invoice as
      // reflecting these figures.
      outcome.resynced = true;

      // Row 394 fix (two independent reviewers, HIGH): a successful re-sync
      // is the only PROVABLE resolution for isStaleInvoiceSnapshot's two
      // markers, and this branch just wrote the invoice to exactly the
      // figures resolveAgreedTotal(<the caller's current snapshot>,
      // quote.result) resolves to — both amend/route.ts and
      // amend-decline/route.ts derive `newTotal` (this function's own
      // parameter) that way, from the snapshot state that is already
      // persisted by the time this call runs. That is the identical
      // condition both markers exist to flag a violation of:
      //   - invoiceResyncFailed: trivially resolved — this IS the
      //     successful resync (possibly a later one than the failed one).
      //   - paymentBlocked: pay-balance's guard 409s a payment when
      //     invoice.balance disagrees with that same resolveAgreedTotal-
      //     derived figure. A successful resync makes that disagreement
      //     false by construction, so the condition that tripped the guard
      //     no longer holds.
      // Best-effort, never blocks the caller's own success.
      await clearInvoiceStaleMarkers(invoiceForSync.quote_id, logPrefix);

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

    // Lost the race: something else (realistically the Valor balance-settle
    // webhook — see the comment above this loop) committed a write to this
    // invoice between the re-read and this write. Retry ONCE against a fresh
    // re-read before giving up — most losses here are exactly that benign
    // interleave, and recomputing totals/reconciledStatus against the new row
    // (top of the next iteration) converges past it.
    if (attempt < MAX_ATTEMPTS && jobId) {
      console.warn(
        `${logPrefix} invoice re-sync lost a concurrent race (invoice ${invoiceForSync.id}, updated_at moved past ${invoiceForSync.updated_at}) — retrying once against a fresh read`,
      );
      const retryInvoice = await getInvoiceByJob(jobId);
      if (!retryInvoice) {
        console.error(
          `${logPrefix} invoice re-sync retry couldn't re-read invoice ${invoiceForSync.id} — giving up; the invoice was NOT updated to the new agreed total`,
        );
        await flagInvoiceResyncFailed(invoiceForSync, totals, logPrefix);
        return outcome;
      }
      invoiceForSync = retryInvoice;
      continue;
    }

    // Best-effort, same shape as the invErr branch above — the caller's own
    // already-recorded change (the amendment trail entry, or the decline) is
    // never undone, and we must NOT blindly overwrite whatever just won with
    // figures computed against a version of the invoice that's no longer
    // current. `outcome.resynced` stays false so BOTH callers can tell a
    // human the invoice was NOT updated, instead of reporting the planned
    // figures as fact (row 341).
    console.error(
      `${logPrefix} invoice re-sync lost a concurrent race${attempt > 1 ? ' twice' : ''} (invoice ${invoiceForSync.id}, updated_at moved past ${invoiceForSync.updated_at}) — leaving the winning write in place; the invoice was NOT updated to the new agreed total`,
    );
    await flagInvoiceResyncFailed(invoiceForSync, totals, logPrefix);
    return outcome;
  }

  // Unreachable — every loop iteration returns. Satisfies the function's
  // declared return type for control-flow analysis.
  return outcome;
}

// Row 341: a durable, best-effort trace for the (now rare, after the retry
// above) case where a resync is attempted but the invoice ends up NOT
// updated. The SHAPE (a small object merged into quotes.approval_snapshot,
// keyed by name, overwritten by any later occurrence — a running history
// isn't needed here, this is a "something's wrong, go look" flag, not an
// audit log) mirrors the Valor balance webhook's own
// flagBalanceUnderpayment/duplicate-payment stamps
// (src/app/api/integrations/valor/webhook/route.ts). The WRITE ITSELF does
// NOT mirror them: those are blind read-modify-writes with no CAS (an
// out-of-scope pre-existing gap in that file, not touched here) — this one
// CASes on the exact prior snapshot it read, matching every OTHER writer of
// this column instead (amend, amend-consent, amend-decline,
// color-change-request, apply-color-request, free-items — see the function
// below for why). Never throws — a failure here must never turn a
// best-effort trace into a request failure.
// Row 341 fix round 2 (technical-lens HIGH, real, re-derived independently):
// the ORIGINAL version of this function was a blind read-modify-write — a
// select, then an unconditional update carrying only `.eq('id', ...)`. Every
// OTHER writer of quotes.approval_snapshot in this codebase (amend,
// amend-consent, amend-decline, color-change-request, apply-color-request,
// free-items) instead re-fetches fresh and CASes with
// `.eq('approval_snapshot', JSON.stringify(prior))` — color-change-request's
// own comment names exactly why (F-014): a blind write here could silently
// REVERT a customer's concurrently-recorded pendingColorRequest, a frozen
// pricing snapshot, or any other field a concurrent writer just added,
// because the write always overwrites the WHOLE column with whatever this
// function read moments earlier. Matches the sibling idiom exactly below. A
// lost race is handled by DROPPING the marker (never retried, never
// overwrites blind) — a missing forensic marker is survivable (the
// response-level `invoiceResyncFailed` flag already told the acting
// operator synchronously); clobbering a customer's snapshot is not.
async function flagInvoiceResyncFailed(
  invoiceForSync: InvoiceRow,
  totals: InvoiceTotals,
  logPrefix: string,
): Promise<void> {
  if (!invoiceForSync.quote_id) return;
  try {
    const sb = getSupabaseServiceClient();
    if (!sb) return;
    const { data: quoteRow } = await sb
      .from('quotes')
      .select('approval_snapshot')
      .eq('id', invoiceForSync.quote_id)
      .maybeSingle<{ approval_snapshot: Record<string, unknown> | null }>();
    const priorSnapshot = quoteRow?.approval_snapshot ?? {};
    const nextSnapshot = {
      ...priorSnapshot,
      invoiceResyncFailed: {
        invoiceId: invoiceForSync.id,
        attemptedTotal: totals.total,
        attemptedBalance: totals.balance,
        at: new Date().toISOString(),
      },
    };
    const { data: updated, error } = await sb
      .from('quotes')
      .update({ approval_snapshot: nextSnapshot })
      .eq('id', invoiceForSync.quote_id)
      // Serialize jsonb explicitly — PostgREST string-interpolates filter
      // values; passing the object directly would produce "[object Object]"
      // and never match (same reasoning as every sibling CAS in this repo).
      .eq('approval_snapshot', JSON.stringify(priorSnapshot))
      .select('id');
    if (error) {
      console.error(`${logPrefix} failed to flag the invoice re-sync failure on the quote:`, error);
      return;
    }
    if (!updated || updated.length === 0) {
      // Lost the race — something else wrote approval_snapshot in the gap
      // between the read above and this write. Drop the marker; do NOT
      // retry (a retry-then-clobber loop is exactly the hazard this CAS
      // exists to avoid) and do NOT blind-overwrite the winner.
      console.warn(
        `${logPrefix} invoiceResyncFailed marker lost a concurrent write to quote ${invoiceForSync.quote_id}'s approval_snapshot — dropped (best-effort, not retried)`,
      );
    }
  } catch (err) {
    console.error(`${logPrefix} failed to flag the invoice re-sync failure on the quote:`, err);
  }
}

// Row 394 fix: the CLEAR side of isStaleInvoiceSnapshot's two markers,
// TWO callers, and the distinction between them is the whole safety argument:
//
//   1. resyncInvoiceToAgreedTotal's own success branch above — see the comment
//      at that call site for why a successful resync PROVES both markers
//      resolved.
//   2. POST /api/invoices/[id]/charge-balance, but ONLY on a charge whose
//      stale-vs-agreed-total check actually RAN AND PASSED (row 404). That
//      check compares the invoice balance against the same
//      resolveAgreedTotal-derived figure both markers exist to flag a
//      violation of, so passing it re-establishes the same condition a resync
//      would, and the charge then settles the invoice to paid/$0.
//
// NOT called when that charge used `overrideStale`. An override means the
// operator asserted the figure by hand and charged the amount ON FILE, which
// may differ from the agreed total — so the discrepancy is still real and the
// marker is the only record that this order was billed off a stale figure.
// Clearing it there would erase a money signal, not resolve one. (Ledger row
// 404 originally proposed exactly that; it is the wrong half of the branch.) Same shape as
// flagInvoiceResyncFailed: read-then-CAS on the exact prior snapshot, drop
// (never retry, never blind-overwrite) on a lost race, never throws. Scoped
// to exactly the two marker keys — every other approval_snapshot field
// (amendments, invoice_basis, pendingColorRequest, ...) rides through
// untouched, via object-rest-destructure rather than a blind merge.
export async function clearInvoiceStaleMarkers(
  quoteId: string | null | undefined,
  logPrefix: string,
): Promise<void> {
  if (!quoteId) return;
  try {
    const sb = getSupabaseServiceClient();
    if (!sb) return;
    const { data: quoteRow } = await sb
      .from('quotes')
      .select('approval_snapshot')
      .eq('id', quoteId)
      .maybeSingle<{ approval_snapshot: Record<string, unknown> | null }>();
    const priorSnapshot = quoteRow?.approval_snapshot ?? null;
    if (!priorSnapshot || (!priorSnapshot.paymentBlocked && !priorSnapshot.invoiceResyncFailed)) {
      return; // nothing to clear
    }
    const nextSnapshot = Object.fromEntries(
      Object.entries(priorSnapshot).filter(([key]) => key !== 'paymentBlocked' && key !== 'invoiceResyncFailed'),
    );
    const { data: updated, error } = await sb
      .from('quotes')
      .update({ approval_snapshot: nextSnapshot })
      .eq('id', quoteId)
      // Serialize jsonb explicitly — PostgREST string-interpolates filter
      // values; passing the object directly would produce "[object Object]"
      // and never match (same reasoning as every sibling CAS in this repo).
      .eq('approval_snapshot', JSON.stringify(priorSnapshot))
      .select('id');
    if (error) {
      console.error(`${logPrefix} failed to clear the stale-invoice markers on the quote:`, error);
      return;
    }
    if (!updated || updated.length === 0) {
      // Lost the race — drop the clear; do NOT retry and do NOT
      // blind-overwrite whatever concurrent write just landed. The marker
      // simply stays until the NEXT successful resync clears it.
      console.warn(
        `${logPrefix} stale-invoice marker clear lost a concurrent write to quote ${quoteId}'s approval_snapshot — dropped (best-effort, not retried)`,
      );
    }
  } catch (err) {
    console.error(`${logPrefix} failed to clear the stale-invoice markers on the quote:`, err);
  }
}
