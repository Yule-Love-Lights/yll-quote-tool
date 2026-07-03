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
//   • A total change moves the quote to the re-consent status (changes_requested):
//     the customer re-approves the new total before any balance is charged (the
//     SPEC §9 default — staff-initiated; re-notification is a follow-up).
//
// No money moves here (no Valor) — collecting the new balance is the separate,
// gated "Charge remaining balance" step.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { computeAmendment, requiresReconsent, type AmendmentTrailEntry } from '@/lib/amend';
import { computeInvoiceTotals, getInvoiceByJob, type InvoicePricingInput } from '@/lib/invoices';
import { resolveAgreedTotal, amendedAgreedTotal } from '@/lib/agreedTotal';
import { canTransition, type InvoiceStatus } from '@/lib/invoiceStatus';
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
  // cancelled/declined/lost row; a live booked order (deposit_paid_at set) derives
  // 'booked'. The select carries `status` + `deposit_paid_at`, which is all
  // deriveStatus needs to resolve those states; the unselected timestamps are null.
  const lifecycleStatus = deriveStatus({
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: quote.deposit_paid_at,
    status: quote.status,
  });
  if (lifecycleStatus === 'cancelled' || lifecycleStatus === 'declined' || lifecycleStatus === 'lost') {
    return NextResponse.json(
      { error: `Cannot amend a ${lifecycleStatus} order`, code: 'not-amendable' },
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

  // Linked job → invoice (exists only once the job is completed): the prior balance
  // + the row to re-sync.
  const job = await getJobByQuote(id);
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

  // Concurrency guard (review HIGH): re-read the snapshot immediately before the
  // write and abort if the amendments trail grew since our initial read. This
  // narrows the read-modify-write window on the auditable financial trail. A FULLY
  // atomic append would be a Postgres RPC (jsonb concat) — flagged for Jason's data
  // layer; `quotes` has no updated_at trigger to optimistic-lock on. The realistic
  // double-click/retry is already blocked by the no-change 409 above + the UI
  // disabling the button mid-request.
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
  const newSnapshot = { ...(fresh?.approval_snapshot ?? snap), amendments: [...freshAmendments, amendment] };
  const { error: upErr } = await sb
    .from('quotes')
    .update({ approval_snapshot: newSnapshot })
    .eq('id', id);
  if (upErr) {
    console.error('[api/quotes/:id/amend] snapshot update failed:', upErr);
    return NextResponse.json({ error: 'Failed to record the amendment' }, { status: 500 });
  }

  // Re-sync the linked invoice (if the job was completed) to the re-priced totals,
  // so the balance the operator collects matches the amended order. Skip a
  // cancelled invoice (don't resurrect it).
  if (invoice && invoice.status !== 'cancelled' && quote.result) {
    // B10 fix (re-read): re-fetch the invoice immediately before the status
    // decision + write to reduce the clobber window. A concurrent balance-webhook
    // or mark-paid between the earlier read and this write could flip the invoice
    // to 'paid'; without a re-read, the stale 'draft'/'awaiting_payment' status
    // would overwrite that settlement. The re-read narrows (but cannot eliminate)
    // that race; a fully atomic approach would require a Postgres RPC.
    const freshInvoice = job ? await getInvoiceByJob(job.id) : null;
    const invoiceForSync = freshInvoice ?? invoice;

    if (invoiceForSync.status !== 'cancelled') {
      // W1-004: re-sync to the AGREED new total (on the selection basis), not the
      // full quote.result.total — the breakdown lines stay from result for display,
      // the load-bearing total/balance use newTotal (same as the amendment trail).
      const totals = computeInvoiceTotals(
        { ...quote.result, total: newTotal },
        depositPaid,
        { taxOverridden: invoiceForSync.tax_overridden },
      );
      // Reconcile the invoice STATUS to the new balance (review MEDIUM): an
      // amended-UP already-paid invoice reopens to awaiting_payment (more is owed);
      // an amended-DOWN invoice that the deposit now covers settles to paid. A
      // draft/awaiting invoice with a remaining balance is left as-is.
      const reconciledStatus: InvoiceStatus =
        totals.balance <= 0
          ? 'paid'
          : invoiceForSync.status === 'paid'
            ? 'awaiting_payment'
            : invoiceForSync.status;

      // B10 fix (defense-in-depth guard): gate the bare status write through
      // canTransition. Every transition the amend re-sync actually performs is
      // already legal (draft/awaiting_payment→paid, paid→awaiting_payment, and the
      // no-op self-transitions all live in invoiceStatus.ts's TRANSITIONS table),
      // so this never blocks a real amend — it's a belt-and-suspenders check that
      // catches a future illegal transition (e.g. resurrecting a cancelled invoice)
      // instead of writing it blindly. A self-transition (status unchanged) is
      // permitted so we still re-sync the money fields.
      if (
        reconciledStatus !== invoiceForSync.status &&
        !canTransition(invoiceForSync.status, reconciledStatus)
      ) {
        console.error(
          `[api/quotes/:id/amend] illegal invoice transition ${invoiceForSync.status} → ${reconciledStatus} (invoice ${invoiceForSync.id}) — skipping re-sync`,
        );
      } else {
        // B10 fix (paid_at): maintain paid_at to match the reconciled status.
        // Stamp on settle-to-paid (amend-down); clear on reopen (amend-up).
        const paidAtPatch: Record<string, unknown> = {};
        if (reconciledStatus === 'paid' && invoiceForSync.status !== 'paid') {
          paidAtPatch.paid_at = new Date().toISOString();
        } else if (reconciledStatus === 'awaiting_payment' && invoiceForSync.status === 'paid') {
          paidAtPatch.paid_at = null;
        }

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
          // The amendment trail is already recorded; an invoice-sync failure is
          // reconcilable (re-run the amendment / edit the invoice). Surface it.
          console.error('[api/quotes/:id/amend] invoice re-sync failed:', invErr);
        }
      }
    }
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
      const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
      const portalUrl = `${baseUrl}/portal/${id}`;
      const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
      try {
        await sendSms({
          contactId: quote.highlevel_contact_id,
          message: amendmentSmsBody(firstName, amendment.new_balance, phone),
          fromNumber: process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined,
        });
        await sendEmail({
          contactId: quote.highlevel_contact_id,
          subject: AMENDMENT_EMAIL_SUBJECT,
          html: amendmentEmailHtml({
            firstName,
            newTotalUsd: amendment.new_total,
            newBalanceUsd: amendment.new_balance,
            portalUrl,
            phone,
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
