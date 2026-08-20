// Amend a booked order (ledger #83 Phase 4, the delicate one — SPEC §4.4).
//
// POST /api/quotes/[id]/amend   (operator-only)
// Body: { reason: string }   — why the order was amended (required, ≤500 chars).
// Response: { ok, requiresReconsent, status, amendment: {...} } | { error, code? }
//
// Re-opening a BOOKED order rewrites the "freeze snapshot / read-only after
// approval" assumption, so this is handled carefully + server-side:
//   • Only a booked (deposit-paid) order can be amended — it has a deposit to apply.
//   • The new total is derived on the AGREED (selection) basis (W1-004): the agreed
//     total + the CHANGE in the full quote since approval (current result.total −
//     the full total frozen at approval), re-priced by editing the order in the
//     builder + Calculate — Jason's #31 flow. Measuring the change (not the raw
//     full result.total) is what stops a selection-diverged order from recording a
//     phantom increase. We NEVER trust a client-supplied total (audit lesson).
//   • The amendment entry from computeAmendment() is APPENDED to
//     approval_snapshot.amendments[] — the original signed snapshot is preserved
//     (the signature attests to the original agreement).
//   • The linked invoice (if the job was completed) is re-synced to the new totals.
//   • A total change marks the amendment PENDING RE-CONSENT: the customer
//     re-approves the new total (portal AmendmentConsentCard -> /amend-consent)
//     before any balance is charged. The quote's own lifecycle status is
//     deliberately NOT moved to changes_requested — see the write below: booked
//     -> changes_requested is not a legal transition and would make a paid order
//     read as a change-request everywhere deriveStatus() is used (review HIGH x3).
//     This comment claimed the opposite until 2026-08-19; the code has always
//     left the status alone.
//
// No money moves here (no Valor) — collecting the new balance is the separate,
// gated "Charge remaining balance" step.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import {
  computeAmendment,
  requiresReconsent,
  resolveAmendmentBasis,
  type AmendmentTrailEntry,
} from '@/lib/amend';
import { getInvoiceByJob, type InvoicePricingInput } from '@/lib/invoices';
import { roundMoney as round2 } from '@/lib/money';
import { resolveAgreedTotal, amendedAgreedTotal } from '@/lib/agreedTotal';
import { resyncInvoiceToAgreedTotal, computeInvoiceResyncTotals } from '@/lib/quoteAmendInvoiceSync';
import { getJobByQuote } from '@/lib/jobs';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { sendSms, sendEmail, isHighLevelConfigured } from '@/lib/integrations/highlevel';
import {
  AMENDMENT_EMAIL_SUBJECT,
  amendmentSmsBody,
  amendmentEmailHtml,
} from '@/lib/integrations/quoteMessages';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;

type QuoteRow = {
  id: string;
  status: QuoteStatus | null;
  deposit_amount_usd: number | null;
  deposit_paid_at: string | null;
  result: (InvoicePricingInput & { total: number }) | null;
  approval_snapshot: {
    customerSelection?: { currentTotalUsd?: number };
    amendments?: AmendmentTrailEntry[];
    // W1-004: the full quote total frozen at approval time — the basis the amend
    // delta measures the builder re-price against (see amendedAgreedTotal).
    pricing?: { total?: number | null } | null;
  } | null;
  // For the optional, staff-initiated customer notice + test-safety (#93).
  customer_name: string | null;
  highlevel_contact_id: string | null;
  is_test: boolean;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { reason?: unknown; notifyCustomer?: unknown };
  try {
    body = (await req.json()) as { reason?: unknown; notifyCustomer?: unknown };
  } catch {
    body = {};
  }
  const notifyCustomer = body.notifyCustomer === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required', code: 'reason-required' }, { status: 400 });
  }
  if (reason.length > MAX_REASON) {
    return NextResponse.json({ error: `Reason must be ≤ ${MAX_REASON} characters` }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, status, deposit_amount_usd, deposit_paid_at, result, approval_snapshot, customer_name, highlevel_contact_id, is_test',
    )
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // Only a BOOKED order has a paid deposit to keep applied through the amendment.
  if (!quote.deposit_paid_at) {
    return NextResponse.json(
      { error: 'Only a booked order (deposit paid) can be amended', code: 'not-booked' },
      { status: 409 },
    );
  }

  // W1-011: gate on the LIFECYCLE status too, not just deposit_paid_at. Cancelling
  // a booked order sets status='cancelled' but leaves deposit_paid_at intact, so a
  // cancelled (or otherwise terminal) order would still pass the check above.
  // Amending a dead order records a trail entry and can text the customer a new
  // balance — reject it. deriveStatus returns the persisted terminal status for a
  // cancelled/declined/abandoned row; a live booked order (deposit_paid_at set) derives
  // 'booked'. The select carries `status` + `deposit_paid_at`, which is all
  // deriveStatus needs to resolve those states; the unselected timestamps are null.
  const lifecycleStatus = deriveStatus({
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: quote.deposit_paid_at,
    status: quote.status,
  });
  if (lifecycleStatus === 'cancelled' || lifecycleStatus === 'declined' || lifecycleStatus === 'abandoned') {
    return NextResponse.json(
      { error: `Cannot amend a ${lifecycleStatus} order`, code: 'not-amendable' },
      { status: 409 },
    );
  }

  // WT-21: gate on the linked JOB's status too, independent of the quote's own
  // status column above. jobs/[id]/cancel/route.ts writes the job to
  // 'cancelled' FIRST, then best-effort writes the source quote's status — if
  // that quote-status write fails, the quote can still read 'booked' (passing
  // both checks above) while its job already reads 'cancelled'. Fetched here
  // (rather than at its original later spot) so the job-cancelled gate runs
  // before any amendment math; the same `job` is reused below for the invoice
  // re-sync.
  const job = await getJobByQuote(id);
  if (job?.status === 'cancelled') {
    return NextResponse.json(
      { error: 'Cannot amend an order whose job has been cancelled', code: 'job-cancelled' },
      { status: 409 },
    );
  }

  const snap = quote.approval_snapshot ?? {};
  const amendments = Array.isArray(snap.amendments) ? snap.amendments : [];
  // Prior agreed total: the last amendment's new_total, else the original agreed
  // SELECTION total in the snapshot, else the current result (a never-amended
  // fresh book). resolveAgreedTotal encodes that exact precedence.
  const previousTotal = resolveAgreedTotal(snap, quote.result);
  const depositPaid = quote.deposit_amount_usd ?? 0;
  // W1-004 — the amend delta semantic: BOTH totals must be on the same (agreed
  // SELECTION) basis. The builder re-prices the WHOLE quote, so the current
  // result.total is FULL-scope, while previousTotal is a selection subset;
  // subtracting one basis from the other invents a phantom increase equal to the
  // original divergence on any order where the customer deselected items / picked
  // a cheaper tier at approval. Instead we measure ONLY what staff changed —
  // result.total − the full total frozen at approval (snapshot.pricing.total) —
  // and apply that shift to the agreed total. No builder edit → shift 0 → the
  // amend correctly reads no-change (never a phantom +delta). Legacy rows with no
  // frozen full total fall back to the current full basis (pre-fix behavior, safe
  // for the non-diverged path). The NEW total is server-derived — never a client
  // value.
  const newTotal = amendedAgreedTotal(snap, quote.result, previousTotal);

  // Linked job (fetched above for the WT-21 gate) → invoice (exists only once
  // the job is completed): the prior balance + the row to re-sync.
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  // The trail's previous_balance is derived from the SAME base as previous_total
  // (review LOW — internal consistency), not from the live invoice.balance (which
  // is re-synced separately below for collection).
  const previousBalance = Math.max(0, previousTotal - depositPaid);

  // Actor for the trail — the named operator once #81 is live; 'staff' while dormant.
  const op = await getOperator();
  const by = op?.name ? `staff:${op.name}` : op?.email ? `staff:${op.email}` : 'staff';

  let amendment: AmendmentTrailEntry;
  try {
    amendment = computeAmendment({ previousTotal, depositPaid, previousBalance, newTotal, by, reason });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Invalid amendment' },
      { status: 400 },
    );
  }

  // Every real total change gets an explicit pending-consent marker. Historical
  // entries without this field are still treated as pending by amend.ts, but new
  // writes are self-describing for the portal and settlement gates.
  if (requiresReconsent(amendment)) {
    amendment.consent = { status: 'pending' };
  }

  // No real price change → guide the operator to re-price in the builder first
  // (this MVP records the financial delta; line-level edits happen in the builder).
  if (Math.abs(amendment.delta) < 0.005) {
    return NextResponse.json(
      {
        error:
          'No price change detected — edit the order in the builder (Calculate) first, then record the amendment.',
        code: 'no-change',
      },
      { status: 409 },
    );
  }

  // FIX A (delta-verify HIGH, fix round 4): compute the invoice-basis figures
  // BEFORE the amendment is persisted, and stamp them onto `amendment` here —
  // so they ride the ONE write below instead of a second, independent CAS
  // write that could silently lose a race (round 3's bug: the stamp used
  // outcome.previousInvoicedTotal from the invoice re-sync's OWN fresh
  // re-read, taken well after this route's first write; a concurrent write
  // to approval_snapshot in that gap made the second CAS match 0 rows with
  // no error at all).
  //
  // FIX B (task (a), fix round 5): re-read the invoice HERE, immediately
  // before computing the basis payload below, instead of reusing the `invoice`
  // fetched near the top of this handler (before computeAmendment / the
  // no-change guard ran). That earlier read left a stale-invoice window open —
  // a concurrent re-sync, mark-paid, or tax-override edit landing between the
  // two could persist a basis computed from an invoice.total/tax_overridden
  // that's already wrong by the time this stamp lands in the write below.
  // Same fallback idiom as resyncInvoiceToAgreedTotal's own B10 re-read
  // (quoteAmendInvoiceSync.ts): getInvoiceByJob swallows its own read errors
  // and returns null, so `?? invoice` falls back to the earlier read rather
  // than silently dropping the stamp on a transient failure. This narrows,
  // but (short of a Postgres RPC) cannot fully eliminate, the window — the
  // remaining gap is between this re-read and the CAS write a few lines
  // below, not the whole handler.
  //
  // previousInvoicedTotal is that freshly re-read invoice's CURRENT total.
  // The new invoice-basis total is a PURE computation (computeInvoiceResyncTotals,
  // from quoteAmendInvoiceSync.ts — the SAME function the re-sync below calls
  // on these SAME inputs, so the two can't drift into different numbers).
  // Guarded identically to the re-sync call below (invoice exists, not
  // cancelled, quote.result present) — the re-sync call itself does its OWN
  // independent fresh re-read (B10), so it stays correct even if this read
  // and that one land on different snapshots of the invoice.
  //
  // If the re-sync below still fails for any reason (a genuine DB error, or
  // a concurrent change this read couldn't see), the amendment trail entry
  // already carries these figures and the customer notice (below) reads
  // them from the SAME `amendment` object — the stamp and the notice always
  // agree, even when the invoice itself never actually got updated to match.
  // That's strictly better than before: previously a re-sync failure left
  // the SECOND write ungated on anything (it ran only when the re-sync
  // reported success), so this exact failure mode couldn't yet produce a
  // stamped-but-unsent-to-invoice figure — but a LOST CAS RACE on a
  // *successful* re-sync could, and silently, which is the bug FIX A fixed.
  const invoiceForBasis = (job ? await getInvoiceByJob(job.id) : null) ?? invoice;
  if (invoiceForBasis && invoiceForBasis.status !== 'cancelled' && quote.result) {
    const planned = computeInvoiceResyncTotals(
      quote.result,
      depositPaid,
      newTotal,
      invoiceForBasis.tax_overridden,
    );
    if (typeof invoiceForBasis.total === 'number' && Number.isFinite(invoiceForBasis.total)) {
      amendment.invoice_basis = {
        previous_total: invoiceForBasis.total,
        new_total: planned.total,
        delta: round2(planned.total - invoiceForBasis.total),
      };
    }
  }

  // Re-read immediately before the write for a fast conflict response. The
  // update below also compare-and-swaps the serialized full snapshot, which closes
  // the remaining window where two requests could both pass this length check and
  // the last writer would erase the other financial trail entry.
  const { data: fresh } = await sb
    .from('quotes')
    .select('approval_snapshot')
    .eq('id', id)
    .maybeSingle<{ approval_snapshot: { amendments?: AmendmentTrailEntry[] } | null }>();
  const freshAmendments = Array.isArray(fresh?.approval_snapshot?.amendments)
    ? fresh!.approval_snapshot!.amendments!
    : [];
  if (freshAmendments.length !== amendments.length) {
    return NextResponse.json(
      { error: 'The order changed while you were amending — please retry.', code: 'concurrent-amend' },
      { status: 409 },
    );
  }

  // Persist: APPEND the trail entry (never overwrite the original signed snapshot).
  // The quote's lifecycle status is left UNCHANGED — it stays `booked` (the deposit
  // is still paid). Re-consent is tracked by the amendment trail (requiresReconsent),
  // NOT by overloading the quote status: booked→changes_requested is not a legal
  // transition (quoteStatus.ts) and would make a paid order read as a change-request
  // everywhere deriveStatus() is used (review HIGH ×3).
  const priorSnapshot = fresh?.approval_snapshot ?? snap;
  const newSnapshot = { ...priorSnapshot, amendments: [...freshAmendments, amendment] };
  const { data: updatedQuotes, error: upErr } = await sb
    .from('quotes')
    .update({ approval_snapshot: newSnapshot })
    .eq('id', id)
    // PostgREST string-interpolates filter values. Serialize jsonb explicitly;
    // passing the object would produce "[object Object]" and never match.
    .eq('approval_snapshot', JSON.stringify(priorSnapshot))
    .select('id');
  if (upErr) {
    console.error('[api/quotes/:id/amend] snapshot update failed:', upErr);
    return NextResponse.json({ error: 'Failed to record the amendment' }, { status: 500 });
  }
  if (!updatedQuotes || updatedQuotes.length === 0) {
    return NextResponse.json(
      { error: 'The order changed while you were amending — please retry.', code: 'concurrent-amend' },
      { status: 409 },
    );
  }

  // Re-sync the linked invoice (if the job was completed) to the re-priced totals,
  // so the balance the operator collects matches the amended order. Skip a
  // cancelled invoice (don't resurrect it). FIX2 (review HIGH): this re-sync is
  // now shared with /amend-decline (src/lib/quoteAmendInvoiceSync.ts) — a
  // decline used to leave the invoice frozen at the rejected figures.
  //
  // FIX A (fix round 4): this is now a PURE side effect on the invoices table
  // — its return value is unused. The figures the customer notice quotes (and
  // the figures already persisted in amendment.invoice_basis, above) are the
  // PLANNED numbers computed before write 1, not this call's outcome; see the
  // comment above the pre-write computation for why the two can't diverge in
  // the case that matters (a successful re-sync), and what happens when they
  // theoretically could (an unsuccessful one).
  if (invoice && invoice.status !== 'cancelled' && quote.result) {
    await resyncInvoiceToAgreedTotal({
      jobId: job ? job.id : null,
      invoice,
      result: quote.result,
      depositPaid,
      newTotal,
      logPrefix: '[api/quotes/:id/amend]',
      retiredReason: 'amend-reopen',
    });
  }

  // Optional, STAFF-INITIATED customer notice of the change (SPEC §4.4 re-consent
  // default — the operator opts in). Best-effort + TEST-SAFE: a test quote NEVER
  // fires a real SMS/email. Failures don't fail the amendment (already recorded).
  let notified = false;
  let notifyError: string | undefined;
  if (notifyCustomer) {
    if (quote.is_test) {
      notifyError = 'test-quote'; // simulated — no real message sent
    } else if (!quote.highlevel_contact_id || !isHighLevelConfigured()) {
      notifyError = 'not-configured';
    } else {
      const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
      // Whether the install is genuinely still AHEAD of this customer, which is
      // the only case where telling them the balance is due "after
      // installation" is true.
      //
      // Delta-verify HIGH: this was first written as `!invoice`, on the premise
      // that an invoice exists only once a job is complete. The forward premise
      // holds, but the CONVERSE does not — getJobByQuote and getInvoiceByJob
      // both swallow a read error and return null (src/lib/jobs.ts,
      // src/lib/invoices.ts), and jobs/[id]/complete commits the status advance
      // BEFORE creating the invoice, so an already-installed job can sit with a
      // null invoice after a failed/unretried create. Either shape would have
      // told a customer whose lights are already up that their balance is due
      // after an installation that already happened.
      //
      // Keyed on the job's own status instead, as a POSITIVE match on the two
      // pre-install states (repo convention: positive seam gates, never
      // negative — a future status must not silently inherit "pre-install").
      // Fails SAFE: an unreadable/absent job yields false, which states no
      // timing at all rather than a false one.
      const dueAfterInstall = job?.status === 'to_schedule' || job?.status === 'scheduled';
      // FIX A (fix round 4): read the SAME basis-resolution the trail entry
      // and the portal card use (resolveAmendmentBasis, amend.ts) — total,
      // balance, and delta all come from ONE source (amendment.invoice_basis
      // when present, else the trail), so the SMS/email can never state a
      // different total/balance/delta than what's persisted or than what the
      // portal will later show. See amend.ts's resolveAmendmentBasis doc
      // comment for the reconciliation guarantee.
      const {
        newTotalUsd: notifiedTotal,
        newBalanceUsd: notifiedBalance,
        deltaUsd: notifiedDelta,
      } = resolveAmendmentBasis(amendment);
      const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
      const portalUrl = `${baseUrl}/portal/${id}`;
      const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
      try {
        await sendSms({
          contactId: quote.highlevel_contact_id,
          message: amendmentSmsBody({
            firstName,
            newBalanceUsd: notifiedBalance,
            phone,
            dueAfterInstall,
            portalUrl,
            // Same basis as newTotalUsd — see resolveAmendmentBasis above.
            deltaUsd: notifiedDelta,
            newTotalUsd: notifiedTotal,
          }),
          fromNumber: process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined,
        });
        await sendEmail({
          contactId: quote.highlevel_contact_id,
          subject: AMENDMENT_EMAIL_SUBJECT,
          html: amendmentEmailHtml({
            firstName,
            newTotalUsd: notifiedTotal,
            newBalanceUsd: notifiedBalance,
            portalUrl,
            phone,
            dueAfterInstall,
            deltaUsd: notifiedDelta,
          }),
          emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
        });
        notified = true;
      } catch (err) {
        // Don't leak the raw integration error back to the operator response —
        // a stable coded sentinel (review LOW); the detail is logged.
        notifyError = 'send-failed';
        console.warn(
          '[api/quotes/:id/amend] customer notify failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return NextResponse.json({
    ok: true,
    requiresReconsent: requiresReconsent(amendment),
    // The lifecycle status is intentionally unchanged (stays booked); re-consent
    // lives in the amendment trail, surfaced to the operator + (optionally) the customer.
    status: quote.status ?? 'booked',
    isTest: !!quote.is_test,
    notified,
    notifyError,
    amendment: {
      previous_total: amendment.previous_total,
      new_total: amendment.new_total,
      delta: amendment.delta,
      new_balance: amendment.new_balance,
      credit_note: amendment.credit_note ?? 0,
      overpayment: !!amendment.overpayment,
    },
  });
}
