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
// #199: body `{ method?: 'cash_check' | 'nce', reference?: string }` — method
// defaults 'cash_check' (back-compat: every existing caller keeps behaving
// identically). method==='nce' REQUIRES a non-empty trimmed reference (an
// empty ref means the trade payment hasn't actually happened yet) — 400
// otherwise, before the WT-18 gate even runs. The WT-18 reconsent gate above
// applies to BOTH methods identically (settling is settling).
//
// A SEPARATE mode, `{ updateReferenceOnly: true, reference }`, edits the NCE
// reference on an ALREADY-PAID NCE invoice (a typo fix) — no settlement, no
// status/balance change, no job-close, no WT-18 gate (nothing to re-consent
// to). 409 unless the invoice is already paid AND paid_method==='nce'.
//
// Response: { ok, paid, invoice: { id, status, balance } } | { error, code? }

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoice, markInvoicePaidManually, updateInvoicePaymentReference, type PaidMethod } from '@/lib/invoices';
import { getJob, setJobStatus } from '@/lib/jobs';
import { latestConsentAmendment, blocksSettlement, amendedQuoteStatus, type AmendmentTrailEntry } from '@/lib/amend';
import type { QuoteStatus } from '@/lib/quoteStatus';

// #199: cap mirrors the column's practical use — a trade reference number,
// not a free-text note. Generous enough for any real NCE reference format.
const MAX_REFERENCE_LEN = 200;

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

  let body: {
    overrideReconsent?: unknown;
    method?: unknown;
    reference?: unknown;
    updateReferenceOnly?: unknown;
  } = {};
  try {
    body = (await req.json()) as typeof body;
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

  // #199: the reference-only edit path — a correction to an ALREADY-SETTLED
  // NCE invoice, never a settlement itself. Returns before the WT-18 gate
  // (nothing here re-opens the invoice or moves money, so there's nothing to
  // re-consent to).
  if (body.updateReferenceOnly === true) {
    if (invoice.status !== 'paid' || invoice.paid_method !== 'nce') {
      return NextResponse.json(
        { error: 'Can only edit the reference on an already-paid NCE invoice.', code: 'not-nce-paid' },
        { status: 409 },
      );
    }
    const editReference = typeof body.reference === 'string' ? body.reference.trim() : '';
    if (!editReference) {
      return NextResponse.json(
        {
          error: 'An NCE payment reference # is required — no ref means the trade payment has not happened yet.',
          code: 'reference-required',
        },
        { status: 400 },
      );
    }
    if (editReference.length > MAX_REFERENCE_LEN) {
      return NextResponse.json(
        { error: `Payment reference is too long (${MAX_REFERENCE_LEN} characters max).`, code: 'reference-too-long' },
        { status: 400 },
      );
    }
    const updated = await updateInvoicePaymentReference(id, editReference);
    if (!updated) {
      return NextResponse.json({ error: 'Could not update the reference', code: 'update-failed' }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      paid: true,
      invoice: { id: updated.id, status: updated.status, balance: updated.balance },
    });
  }

  // #199: method defaults 'cash_check' for back-compat — every EXISTING
  // caller (no body, or a body without `method`) keeps writing exactly what
  // it always wrote. method==='nce' requires a non-empty trimmed reference.
  const method: PaidMethod = body.method === 'nce' ? 'nce' : 'cash_check';
  let reference: string | null = null;
  if (method === 'nce') {
    const raw = typeof body.reference === 'string' ? body.reference.trim() : '';
    if (!raw) {
      return NextResponse.json(
        {
          error: 'An NCE payment reference # is required — no ref means the trade payment has not happened yet.',
          code: 'reference-required',
        },
        { status: 400 },
      );
    }
    if (raw.length > MAX_REFERENCE_LEN) {
      return NextResponse.json(
        { error: `Payment reference is too long (${MAX_REFERENCE_LEN} characters max).`, code: 'reference-too-long' },
        { status: 400 },
      );
    }
    reference = raw;
  }

  if (!override && invoice.quote_id) {
    const sb = getSupabaseServiceClient()!;
    const { data: quoteRow } = await sb
      .from('quotes')
      .select('approval_snapshot, status')
      .eq('id', invoice.quote_id)
      .maybeSingle<QuoteReconsentRow>();
    const latest = latestConsentAmendment(quoteRow?.approval_snapshot?.amendments);
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
    paid = await markInvoicePaidManually(id, method, reference);
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
