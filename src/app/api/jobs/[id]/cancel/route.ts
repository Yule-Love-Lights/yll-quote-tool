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

    // W1-008: cancelling a deposit-paid order leaves a real refund obligation.
    // Persist it into approval_snapshot (merge — never clobber existing keys like
    // customerSelection/amendments/signature) + alert staff, mirroring the
    // deposit webhook's "money event → durable record + email" pattern, so the
    // obligation survives past this response even if it's missed.
    if (refundedDeposit) {
      // Same source the invoice layer uses for the actually-charged deposit
      // (quotes.deposit_amount_usd; result.depositAmount only as a legacy fallback).
      const amountUsd = q?.deposit_amount_usd ?? q?.result?.depositAmount ?? 0;
      const at = new Date().toISOString();
      // Unconditional log so the obligation is traceable even if the DB stamp and
      // the GHL alert below both fail (mirrors W1-006's double-charge log).
      console.error(
        `[api/jobs/:id/cancel] REFUND DUE for quote ${job.quote_id}: $${amountUsd} deposit already charged, order cancelled — refund in Valor`,
      );
      try {
        await sb
          .from('quotes')
          .update({
            approval_snapshot: {
              ...(q?.approval_snapshot ?? {}),
              refundDue: { reason: 'cancelled-deposit-paid', amountUsd, at },
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
            }),
            emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
          });
        }
      } catch (err) {
        console.error('[api/jobs/:id/cancel] refund-due alert email failed:', err);
      }
    }
  }

  const refundedInvoice = !!(invoice && invoice.status === 'paid');
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
  return NextResponse.json({
    ok: true,
    cancelled: true,
    refundedInvoice,
    refundedDeposit,
    refundNeeded,
    quoteCancelled,
    note: notes.join(' '),
  });
}
