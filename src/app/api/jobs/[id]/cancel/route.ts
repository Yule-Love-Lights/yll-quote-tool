// Cancel a booked order (ledger #83 — SPEC §2 Cancellations). OPERATOR-ONLY.
//
// POST /api/jobs/[id]/cancel
// Sets the job → cancelled, its linked invoice → cancelled (if any), and the
// source quote → cancelled. REFUNDS ARE MANUAL IN VALOR (the locked decision —
// no refund integration); the response says so. A `done` job (fully complete +
// paid) can't be cancelled.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getJob, setJobStatus } from '@/lib/jobs';
import { getInvoiceByJob, setInvoiceStatus } from '@/lib/invoices';
import { sendEmail, isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { refundDueEmailSubject, refundDueEmailHtml } from '@/lib/integrations/quoteMessages';
import { releaseAccrualOnCancel } from '@/lib/referrals';
// WT-31: reuse the SAME work-order projection + deduction math the prepare
// path (prepareJobMaterials) uses, read-only — this route never writes to
// src/lib/inventory/jobs.ts.
import { getJobWorkOrder, computeStockDeductions } from '@/lib/inventory/jobs';
import { adjustOnHandAtomic } from '@/lib/inventory/onHand';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }

  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (job.status === 'cancelled') {
    return NextResponse.json({ ok: true, alreadyCancelled: true });
  }
  if (job.status === 'done') {
    return NextResponse.json(
      { error: 'A completed job cannot be cancelled', code: 'job-done' },
      { status: 409 },
    );
  }

  // Cancel the job (legal from any non-terminal billing status).
  try {
    await setJobStatus(id, 'cancelled');
  } catch (err) {
    console.error('[api/jobs/:id/cancel] job cancel failed:', err);
    return NextResponse.json({ error: 'Could not cancel the job' }, { status: 409 });
  }

  // WT-31: a cancelled job that already had its materials PREPPED (on-hand
  // decremented at prep — #82 Phase 2) leaves stock permanently short unless
  // the deduction is reversed. Best-effort — the job is already cancelled
  // either way. Row 325: reverses the job's OWN stock_deductions snapshot
  // (persisted by prepareJobMaterials at prep time) — the exact quantities
  // that were actually taken off stock — rather than recomputing the
  // materials projection live, which would silently drift from what prep
  // really deducted if the materials rules changed in between. A job prepped
  // BEFORE this snapshot existed has none (wo.job.stockDeductions null while
  // stockDecrementedAt is set); for those legacy jobs only, this falls back
  // to the old live reconstruction via getJobWorkOrder + computeStockDeductions
  // and says so in the note. Test jobs (ledger #93) never touched real
  // on-hand at prep, so there's nothing to return for them.
  const stockReturned: { sku: string; qty: number }[] = [];
  let stockReturnNote: string | null = null;
  try {
    const wo = await getJobWorkOrder(id);
    if (wo?.job.stockDecrementedAt && !wo.job.isTest) {
      const stockSb = getSupabaseServiceClient()!;
      // WT-31 (concurrency): the top `status === 'cancelled'` guard only stops a
      // SEQUENTIAL re-cancel. Two CONCURRENT cancel POSTs (an operator
      // double-click) both read a non-cancelled job and both reach here, and
      // adjustOnHandAtomic has no cross-call idempotency — each would add the
      // same +qty, over-crediting on-hand into phantom stock. Atomically CLAIM
      // the reversal by clearing stock_decremented_at WHERE it's still set
      // (the INVERSE of prepareJobMaterials's NULL→now claim); only the caller
      // that flips it non-null → NULL runs the return. The job is terminal
      // (cancelled), so it's never re-prepped and the cleared marker is inert.
      const { data: claimed } = await stockSb
        .from('jobs')
        .update({ stock_decremented_at: null, stock_deductions: null })
        .eq('id', id)
        .not('stock_decremented_at', 'is', null)
        .select('id')
        .maybeSingle();
      if (claimed) {
        // Row 325: prefer the snapshot prep actually deducted. Only fall back
        // to a live reconstruction when no snapshot exists — a legacy job
        // prepped before this column shipped.
        const usingSnapshot = wo.job.stockDeductions != null;
        const deductions = usingSnapshot
          ? wo.job.stockDeductions!
          : computeStockDeductions(wo.materials.materials);
        if (deductions.length) {
          for (const d of deductions) {
            try {
              // Positive delta returns exactly what prep deducted — mirrors
              // prepareJobMaterials's negative delta (adjustOnHandAtomic in
              // onHand.ts).
              await adjustOnHandAtomic(stockSb, d.sku, d.deducted);
              stockReturned.push({ sku: d.sku, qty: d.deducted });
            } catch (err) {
              console.error(`[api/jobs/:id/cancel] stock return failed for ${d.sku}:`, err);
            }
          }
        } else {
          stockReturnNote =
            'Materials were marked prepped for this job — no trackable on-hand stock to reverse automatically; check manually.';
        }
        if (!usingSnapshot) {
          const legacyNote =
            'No per-prep snapshot was recorded for this job (prepped before this fix shipped) — the reversal was reconstructed from the CURRENT materials projection and may not exactly match what prep originally deducted.';
          stockReturnNote = stockReturnNote ? `${stockReturnNote} ${legacyNote}` : legacyNote;
        }
      }
    }
  } catch (err) {
    console.error('[api/jobs/:id/cancel] stock-return check failed:', err);
  }

  // Cancel the linked invoice if one exists (cancel is legal from any non-cancelled
  // invoice status, including paid → a paid-then-cancelled invoice means a MANUAL
  // Valor refund). Best-effort: the job is already cancelled.
  const invoice = await getInvoiceByJob(id);
  if (invoice && invoice.status !== 'cancelled') {
    try {
      await setInvoiceStatus(invoice.id, 'cancelled');
    } catch (err) {
      console.error('[api/jobs/:id/cancel] invoice cancel failed:', err);
    }
  }

  // WT-17: read BEFORE the cancel above can change DB state — this local
  // `invoice` object still reflects the pre-cancel read (setInvoiceStatus
  // doesn't mutate it), so a paid invoice still reads paid here. A paid
  // invoice means the WHOLE order (deposit + balance) was already collected —
  // a bigger refund obligation than a deposit-only cancellation.
  const refundedInvoice = !!(invoice && invoice.status === 'paid');

  // Cancel the source quote too (operator-initiated; written directly via the
  // service-role client — a deliberate booking cancellation). Read its deposit
  // state FIRST so we can flag a deposit refund even when no invoice exists yet —
  // a booked-but-not-completed order still took a 50% deposit (review MEDIUM).
  let refundedDeposit = false;
  let quoteCancelled = true;
  if (job.quote_id) {
    const sb = getSupabaseServiceClient()!;
    const { data: q } = await sb
      .from('quotes')
      .select('deposit_paid_at, deposit_amount_usd, result, customer_name, highlevel_contact_id, approval_snapshot')
      .eq('id', job.quote_id)
      .maybeSingle<{
        deposit_paid_at: string | null;
        deposit_amount_usd: number | null;
        result: { depositAmount?: number } | null;
        customer_name: string | null;
        highlevel_contact_id: string | null;
        approval_snapshot: Record<string, unknown> | null;
      }>();
    refundedDeposit = !!q?.deposit_paid_at;
    const { error } = await sb.from('quotes').update({ status: 'cancelled' }).eq('id', job.quote_id);
    if (error) {
      console.error('[api/jobs/:id/cancel] quote cancel failed:', error);
      quoteCancelled = false;
    }

    // Referral program (#41 adversarial-review MED fix): a cancelled order
    // never happened, so its referrer shouldn't keep 'booked' credit for it.
    // Fail-open — releaseAccrualOnCancel already swallows its own errors, but
    // this is wrapped anyway (matches the refund-due block below) so the
    // cancel response can never be broken by an accrual-reversal hiccup.
    try {
      await releaseAccrualOnCancel(job.quote_id);
    } catch (err) {
      console.error('[api/jobs/:id/cancel] referral accrual release failed:', err);
    }

    // W1-008 / WT-17: cancelling a paid order leaves a real refund obligation —
    // either the deposit alone, or (when the invoice was already paid in full)
    // the WHOLE order total. Persist it into approval_snapshot (merge — never
    // clobber existing keys like customerSelection/amendments/signature) +
    // alert staff, mirroring the deposit webhook's "money event → durable
    // record + email" pattern, so the obligation survives past this response
    // even if it's missed.
    if (refundedInvoice || refundedDeposit) {
      // A fully-paid invoice already collected the deposit AND the balance —
      // using deposit_amount_usd here would silently under-state the real
      // amount owed back. Otherwise (deposit-only), same source the invoice
      // layer uses for the actually-charged deposit (quotes.deposit_amount_usd;
      // result.depositAmount only as a legacy fallback).
      //
      // WT-17 follow-up: cash actually collected on a paid invoice is
      // max(total, deposit_applied), NOT total alone. An order amended DOWN
      // below its deposit auto-settles the invoice to paid with a credit_note
      // (total < deposit_applied), so the customer is owed the larger
      // deposit_applied — `invoice.total` would under-refund by the credit_note.
      const amountUsd = refundedInvoice
        ? Math.max(invoice?.total ?? 0, invoice?.deposit_applied ?? 0)
        : (q?.deposit_amount_usd ?? q?.result?.depositAmount ?? 0);
      const reason = refundedInvoice ? 'cancelled-paid-in-full' : 'cancelled-deposit-paid';
      const at = new Date().toISOString();
      // Unconditional log so the obligation is traceable even if the DB stamp and
      // the GHL alert below both fail (mirrors W1-006's double-charge log).
      console.error(
        `[api/jobs/:id/cancel] REFUND DUE for quote ${job.quote_id}: $${amountUsd} ${
          refundedInvoice ? 'already collected in full' : 'deposit already charged'
        }, order cancelled — refund in Valor`,
      );
      try {
        await sb
          .from('quotes')
          .update({
            approval_snapshot: {
              ...(q?.approval_snapshot ?? {}),
              refundDue: { reason, amountUsd, at },
            },
          })
          .eq('id', job.quote_id);
      } catch (err) {
        console.error('[api/jobs/:id/cancel] refund-due snapshot stamp failed:', err);
      }

      try {
        const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
        if (isHighLevelConfigured() && internalContactId) {
          const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
          await sendEmail({
            contactId: internalContactId,
            subject: refundDueEmailSubject(q?.customer_name ?? null),
            html: refundDueEmailHtml({
              customerName: q?.customer_name ?? null,
              amountUsd,
              adminUrl: `${baseUrl}/quote/${job.quote_id}`,
              full: refundedInvoice,
            }),
            emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
          });
        }
      } catch (err) {
        console.error('[api/jobs/:id/cancel] refund-due alert email failed:', err);
      }
    }
  }

  const refundNeeded = refundedInvoice || refundedDeposit;
  // #110 W6-010: surface a failed source-quote status write so the operator
  // doesn't see an unqualified success while the quote can still read as
  // bookable/booked in the portal and quote list.
  const notes = [
    refundNeeded
      ? 'A payment was already taken — issue the refund manually in Valor.'
      : 'No payment was taken — nothing to refund.',
  ];
  if (!quoteCancelled) {
    notes.push('The job was cancelled but the source quote could not be updated — check manually.');
  }
  // WT-31: surface the stock reversal (or the fallback note when nothing
  // trackable could be reversed) the same way the refund note is surfaced.
  // Row 325: these are independent now (not else-if) — a legacy-job caveat
  // (stockReturnNote) can accompany an actual "Returned to stock" line, not
  // just replace it, since the reconstruction path can still return SOMETHING
  // while being worth flagging as unverified.
  if (stockReturned.length) {
    notes.push(`Returned to stock: ${stockReturned.map((s) => `${s.qty}×${s.sku}`).join(', ')}.`);
  }
  if (stockReturnNote) {
    notes.push(stockReturnNote);
  }
  return NextResponse.json({
    ok: true,
    cancelled: true,
    refundedInvoice,
    refundedDeposit,
    refundNeeded,
    quoteCancelled,
    stockReturned,
    note: notes.join(' '),
  });
}
