// POST /api/jobs/[id]/close  (operator-only)
//
// Finalize a job: settle the linked invoice (if unpaid) with an offline/manual
// payment, then advance the job to `done` through the LEGAL jobStatus transitions.
// The invoice settlement reuses markInvoicePaidManually (atomic .neq('status','paid')
// claim — idempotent, no double-settle).
//
// Transition ladder (only through legal steps):
//   to_schedule | scheduled → installed → requires_invoicing → done
//
// A job already `done` is an idempotent no-op (200 { alreadyDone:true }).
// A cancelled job is rejected (400). A job with NO invoice is rejected (409
// no-invoice) — close = finalize + settle, so it must be invoiced first (via
// Complete); closing an un-invoiced job would forfeit the untracked balance.
// A close race (setJobStatus throws because a concurrent request already
// advanced past a step) re-reads: if already `done`, returns success; else 409.
//
// #199 (F2): the bare markInvoicePaidManually call below always settles as
// method:'cash_check' — an NCE-linked invoice REFUSES that (409
// 'nce-mismatch'), so a job can't be silently closed with its NCE invoice
// mislabeled. Staff must record the trade reference via the invoice's
// "Mark paid — NCE" panel first; closing then proceeds normally (the invoice
// is already 'paid', so this settle block is skipped entirely).
//
// WT-18: before settling the invoice, block a quote whose LATEST amendment is
// a price-increasing change the customer hasn't re-approved yet
// (src/lib/amend.ts blocksSettlement/requiresReconsent) — an amend-up silently
// reopens the invoice to awaiting_payment with zero proof of re-consent, and
// closing the job would otherwise settle it right past that. An operator
// override (body `{ overrideReconsent: true }` or `?override=true`) is the
// release valve for this wave; a real customer-facing re-approval flow is
// separate, later work.
//
// Response: { ok, closed:true } | { ok, alreadyDone:true } | { error, code? }

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getJob, setJobStatus, type JobRow } from '@/lib/jobs';
import { getInvoiceByJob, markInvoicePaidManually, InvoiceSettleError } from '@/lib/invoices';
import { moveQuoteCardToInstalled } from '@/lib/integrations/ghlQuoteCard';
import { latestConsentAmendment, blocksSettlement, amendedQuoteStatus, type AmendmentTrailEntry } from '@/lib/amend';
import type { QuoteStatus } from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteReconsentRow = {
  approval_snapshot: { amendments?: AmendmentTrailEntry[] } | null;
  status: QuoteStatus | null;
};

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

  let body: { overrideReconsent?: unknown } = {};
  try {
    body = (await req.json()) as { overrideReconsent?: unknown };
  } catch {
    body = {};
  }
  const override =
    body.overrideReconsent === true || req.nextUrl.searchParams.get('override') === 'true';

  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status === 'cancelled') {
    return NextResponse.json({ error: 'Job is cancelled', code: 'cancelled' }, { status: 400 });
  }
  if (job.status === 'done') return NextResponse.json({ ok: true, alreadyDone: true });

  // Close = finalize + SETTLE, so an invoice must already exist. Closing a job
  // that was never invoiced would advance it straight to `done` with the entire
  // remaining balance untracked (no invoice row to reconcile), silently forfeiting
  // it. Refuse and point the operator at the complete→invoice step rather than
  // auto-creating here (surgical fix — keep this route settle-only).
  const invoice = await getInvoiceByJob(id);
  if (!invoice) {
    return NextResponse.json(
      {
        error: 'This job has no invoice yet — run "Complete" to create the invoice before closing.',
        code: 'no-invoice',
      },
      { status: 409 },
    );
  }
  // Settle the linked invoice if unpaid (close = finalize).
  if (invoice.status !== 'paid' && invoice.status !== 'cancelled') {
    if (!override && invoice.quote_id) {
      const sb = getSupabaseServiceClient()!;
      const { data: quoteRow } = await sb
        .from('quotes')
        .select('approval_snapshot, status')
        .eq('id', invoice.quote_id)
        .maybeSingle<QuoteReconsentRow>();
      // Use latestConsentAmendment (not latestAmendment) so a later COSMETIC
      // zero-delta entry — e.g. a #163 colour apply or a #162 free-item add —
      // can't mask a pending price-increase re-consent and let close settle it.
      // Matches the mark-paid + charge-balance settlement gates.
      const latest = latestConsentAmendment(quoteRow?.approval_snapshot?.amendments);
      if (blocksSettlement(latest)) {
        console.warn(
          `[api/jobs/:id/close] blocked settlement for job ${id} — reconsent required ` +
            `(quote ${invoice.quote_id} would read '${amendedQuoteStatus(latest!, quoteRow?.status ?? 'booked')}')`,
        );
        return NextResponse.json(
          {
            error:
              'This order has a price increase awaiting customer re-approval. Pass an operator override to close anyway.',
            code: 'reconsent-required',
          },
          { status: 409 },
        );
      }
    }
    try {
      await markInvoicePaidManually(invoice.id);
    } catch (err) {
      console.error('[api/jobs/:id/close] settle failed:', err);
      // #199 (F2, wrap-review HIGH): this bare call always defaults to
      // method:'cash_check' — an NCE invoice REFUSES that settle (see
      // markInvoicePaidManually's own gate). Do not silently leave the job
      // open with no explanation — name the invoice + point staff at its
      // dedicated "Mark paid — NCE" panel instead of the generic message.
      if (err instanceof InvoiceSettleError && err.code === 'nce-mismatch') {
        return NextResponse.json(
          {
            error:
              'This job\'s invoice is an NCE trade job — record the NCE payment reference on the invoice\'s "Mark paid — NCE" panel before closing.',
            code: 'nce-mismatch',
            invoiceId: invoice.id,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: 'Could not settle the invoice', code: 'settle-failed' },
        { status: 409 },
      );
    }
  }

  // Advance the job to done through the legal steps.
  let current: JobRow = job;
  try {
    if (current.status === 'to_schedule' || current.status === 'scheduled') {
      current = (await setJobStatus(id, 'installed')) ?? current;
      // Best-effort GHL card move on the FIRST installed transition (#GHL
      // pipeline sync) — shared with /api/jobs/[id]/complete; only fires when
      // the transition actually landed, and never throws (fail-open).
      if (current.status === 'installed') {
        await moveQuoteCardToInstalled(current.quote_id);
      }
    }
    if (current.status === 'installed') {
      current = (await setJobStatus(id, 'requires_invoicing')) ?? current;
    }
    if (current.status === 'requires_invoicing') {
      await setJobStatus(id, 'done');
    }
  } catch (err) {
    // A concurrent close raced us to an already-advanced step. Re-read: if the
    // job landed at `done`, report success; otherwise surface the conflict.
    const fresh = await getJob(id);
    if (fresh && fresh.status === 'done') {
      return NextResponse.json({ ok: true, closed: true });
    }
    console.error('[api/jobs/:id/close] close race:', err);
    return NextResponse.json(
      { error: 'Could not close the job', code: 'close-conflict' },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, closed: true });
}
