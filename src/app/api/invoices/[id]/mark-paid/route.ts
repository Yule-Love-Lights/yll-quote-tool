// POST /api/invoices/[id]/mark-paid  (operator-only)
//
// Operator records an offline/external payment (cash / check / paid in the
// Valor terminal). Calls markInvoicePaidManually which atomically sets
// status='paid', balance=0, paid_at=now (.neq('status','paid') claim) so
// a double-click can't double-settle. Idempotent on an already-paid invoice.
// After the settle, close the linked job (requires_invoicing → done) so the
// pipeline mirrors the Valor balance webhook (which closes the job on balance
// settle). markInvoicePaidManually itself never touches the job, so the route
// does the close best-effort — a job-close failure never fails the payment.
//
// WT-18: before settling, block a quote whose LATEST amendment is a
// price-increasing change the customer hasn't re-approved yet
// (src/lib/amend.ts blocksSettlement/requiresReconsent) — an amend-up silently
// reopens the invoice to awaiting_payment with zero proof of re-consent, and
// this route would otherwise happily settle it. An operator override (body
// `{ overrideReconsent: true }` or `?override=true`) is the release valve for
// this wave; a real customer-facing re-approval flow is separate, later work.
//
// Response: { ok, paid, invoice: { id, status, balance } } | { error, code? }

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoice, markInvoicePaidManually } from '@/lib/invoices';
import { getJob, setJobStatus } from '@/lib/jobs';
import { latestAmendment, blocksSettlement, amendedQuoteStatus, type AmendmentTrailEntry } from '@/lib/amend';
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
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }

  let body: { overrideReconsent?: unknown } = {};
  try {
    body = (await req.json()) as { overrideReconsent?: unknown };
  } catch {
    body = {};
  }
  const override =
    body.overrideReconsent === true || req.nextUrl.searchParams.get('override') === 'true';

  // Pre-fetch the invoice (rather than relying solely on markInvoicePaidManually's
  // own read) so the WT-18 gate below runs BEFORE any money moves.
  const invoice = await getInvoice(id);
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  if (!override && invoice.quote_id) {
    const sb = getSupabaseServiceClient()!;
    const { data: quoteRow } = await sb
      .from('quotes')
      .select('approval_snapshot, status')
      .eq('id', invoice.quote_id)
      .maybeSingle<QuoteReconsentRow>();
    const latest = latestAmendment(quoteRow?.approval_snapshot?.amendments);
    if (blocksSettlement(latest)) {
      console.warn(
        `[api/invoices/:id/mark-paid] blocked settlement for invoice ${id} — reconsent required ` +
          `(quote ${invoice.quote_id} would read '${amendedQuoteStatus(latest!, quoteRow?.status ?? 'booked')}')`,
      );
      return NextResponse.json(
        {
          error:
            'This order has a price increase awaiting customer re-approval. Pass an operator override to settle anyway.',
          code: 'reconsent-required',
        },
        { status: 409 },
      );
    }
  }

  let paid;
  try {
    paid = await markInvoicePaidManually(id);
  } catch (err) {
    console.error('[api/invoices/:id/mark-paid]', err);
    return NextResponse.json(
      { error: 'Invoice cannot be marked paid', code: 'cancelled' },
      { status: 409 },
    );
  }

  if (!paid) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  // Close the linked job once payment is collected (best-effort — the payment is
  // already recorded, so a job-close failure must never fail the request). This
  // mirrors the Valor balance-settle path in the webhook: requires_invoicing → done.
  // markInvoicePaidManually returns the full invoice row (incl. job_id) on every
  // branch, so no extra read is needed to find the job.
  try {
    if (paid.job_id) {
      const job = await getJob(paid.job_id);
      if (job && job.status === 'requires_invoicing') {
        await setJobStatus(job.id, 'done');
      }
    }
  } catch (err) {
    console.error('[api/invoices/:id/mark-paid] job close failed:', err);
  }

  return NextResponse.json({
    ok: true,
    paid: true,
    invoice: { id: paid.id, status: paid.status, balance: paid.balance },
  });
}
