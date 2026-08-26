// POST /api/invoices/[id]/resync  (operator-only)
//
// Row 388 — the standalone "reconcile this invoice" action the row named as
// missing. Row 414 (#973) already gave staff a way to CLEAR the
// paymentBlocked/invoiceResyncFailed markers (mark-reconciled), but that
// route only retires the flag — it never touches the invoice's own
// total/balance/status. The only way to actually rewrite a stale invoice's
// figures to the order's current agreed total was to invent a no-op
// amendment through /amend or /amend-decline, purely to trigger the SAME
// resyncInvoiceToAgreedTotal this route now calls directly.
//
// Money-safe by construction, not by new logic: resyncInvoiceToAgreedTotal
// (src/lib/quoteAmendInvoiceSync.ts) is the EXACT function /amend and
// /amend-decline already call for this — same computeInvoiceResyncTotals
// formula, same optimistic-lock write + one retry, same status
// reconciliation (canTransition-gated), and on a successful write it already
// clears BOTH stale markers itself (see that function's own comment) and
// retires a reopened invoice's live Valor txn. This route adds no new money
// math; it only supplies the missing standalone call site so a staffer can
// resync without recording a fake amendment.
import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoice, type InvoicePricingInput } from '@/lib/invoices';
import { getJobByQuote } from '@/lib/jobs';
import { resolveAgreedTotal, type AgreedTotalSnapshot } from '@/lib/agreedTotal';
import { resyncInvoiceToAgreedTotal } from '@/lib/quoteAmendInvoiceSync';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  result: (InvoicePricingInput & { total: number }) | null;
  approval_snapshot: AgreedTotalSnapshot;
  deposit_amount_usd: number | null;
};

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }

  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  if (invoice.status === 'cancelled') {
    return NextResponse.json(
      { error: 'This invoice is cancelled — nothing to resync.', code: 'cancelled' },
      { status: 409 },
    );
  }
  if (!invoice.quote_id) {
    // The agreed total lives on the linked QUOTE; an invoice with no linked
    // quote structurally has nothing to resync against.
    return NextResponse.json({ error: 'No linked order to resync against', code: 'no-quote' }, { status: 409 });
  }

  const sb = getSupabaseServiceClient()!;
  // Confirmed read, never coerced (the quoteAudit trap 2 pattern this repo's
  // other approval_snapshot readers already follow): a failed read must be a
  // 503 the operator retries, not a silent fall-through with fabricated data.
  const { data: quote, error: readErr } = await sb
    .from('quotes')
    .select('result, approval_snapshot, deposit_amount_usd')
    .eq('id', invoice.quote_id)
    .maybeSingle<QuoteRow>();
  if (readErr || !quote) {
    return NextResponse.json(
      { error: "Couldn't read the order's current state — nothing was changed. Try again.", code: 'read-failed' },
      { status: 503 },
    );
  }
  if (!quote.result) {
    return NextResponse.json(
      { error: 'This order has no priced result to resync the invoice against.', code: 'no-pricing' },
      { status: 409 },
    );
  }

  const job = await getJobByQuote(invoice.quote_id);
  const newTotal = resolveAgreedTotal(quote.approval_snapshot, quote.result);

  const outcome = await resyncInvoiceToAgreedTotal({
    jobId: job ? job.id : null,
    invoice,
    result: quote.result,
    depositPaid: quote.deposit_amount_usd ?? 0,
    newTotal,
    logPrefix: '[api/invoices/:id/resync]',
    retiredReason: 'manual-resync',
  });

  if (!outcome.resynced) {
    // resyncInvoiceToAgreedTotal already flagged invoiceResyncFailed
    // (best-effort) on every failure path — this response just tells the
    // operator synchronously so a resync attempt never silently no-ops.
    return NextResponse.json(
      {
        ok: false,
        error:
          'The invoice could not be resynced — it may have changed concurrently, or hit an illegal status ' +
          'transition. Reload and try again.',
        code: 'resync-failed',
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    invoicedTotal: outcome.invoicedTotal,
    invoicedBalance: outcome.invoicedBalance,
    previousInvoicedTotal: outcome.previousInvoicedTotal,
  });
}
