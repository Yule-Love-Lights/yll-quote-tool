// Customer pays the remaining balance via Valor's HOSTED page (ledger #83 — the
// SPEC §4.3 pay-link fallback to the gated auto-charge).
//
// POST /api/quotes/[id]/pay-balance   (PUBLIC — gated by the quote UUID, like /pay)
// Response: { ok: true, redirectUrl, amountUsd, orderRef } | { error, code? }
//
// Reuses the SAME proven hosted-page sale the 50% deposit uses (createHostedPageSale)
// — NO new Valor capability (distinct from the gated card-on-file auto-charge). The
// order ref is `bal_<quoteId>` so the Valor webhook can tell a BALANCE payment from
// a deposit and mark the INVOICE paid (not re-book). A test quote never reaches
// Valor (it has no real balance to collect).

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { createHostedPageSale, isValorConfigured, ValorError } from '@/lib/integrations/valor';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  is_test: boolean;
  // View-only portal (#176): a staff-flagged browse-only quote can never pay
  // a real balance either — see the check right after the fetch below.
  view_only: boolean;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-pay-balance', limit: 10, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  if (!isValorConfigured()) {
    return NextResponse.json(
      { error: 'Payment processing is not configured yet', code: 'valor-not-configured' },
      { status: 503 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, customer_name, customer_email, is_test, view_only')
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // View-only portal (#176): a staff-flagged browse-only quote must never
  // reach real Valor — server hard-guard, checked before any invoice/balance
  // lookup or Valor call. The portal UI's matching gate is StickyBottomBar's
  // viewOnly branch (the DepositCheckout/pay-balance UI is never mounted).
  if (quote.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
    );
  }

  // A test quote never touches real Valor (it has no real balance to collect).
  if (quote.is_test) {
    return NextResponse.json({ error: 'Test quote — no real balance to collect', code: 'test-quote' }, { status: 400 });
  }

  // The balance lives on the invoice (created when the job is completed).
  const job = await getJobByQuote(id);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  if (!invoice) {
    return NextResponse.json({ error: 'No invoice for this order yet', code: 'no-invoice' }, { status: 409 });
  }
  if (invoice.status === 'cancelled') {
    return NextResponse.json({ error: 'This invoice was cancelled', code: 'cancelled' }, { status: 400 });
  }
  if (invoice.status === 'paid' || invoice.balance <= 0) {
    return NextResponse.json({ error: 'No balance due', code: 'no-balance' }, { status: 409 });
  }

  // `bal_<quoteId>` — round-tripped to the webhook as the invoicenumber so it can
  // route a BALANCE payment to the invoice (vs a deposit, which books a quote).
  const orderRef = `bal_${id}`;
  const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
  // `?balance=paid` tells the approved page the customer just paid off the
  // remaining balance (not the deposit) so it confirms the payment instead of
  // repeating the "collected after install" copy.
  const successUrl = `${baseUrl}/portal/${id}/approved?balance=paid`;
  const failureUrl = `${baseUrl}/portal/${id}/pay-balance`;

  // #187c (belt-and-suspenders): the view_only check above is a fast-path
  // gate at fetch time, but the job/invoice lookups above are two more async
  // hops during which staff could flip the flag ON. Re-check immediately
  // before handing off to Valor so a real hosted-page charge is never opened
  // on a quote that's now view-only. This window is near-unreachable today (a
  // booked quote already refuses the toggle), so this is cheap insurance, not
  // a load-bearing guard.
  const { data: recheck } = await sb
    .from('quotes')
    .select('view_only')
    .eq('id', id)
    .maybeSingle<{ view_only: boolean }>();
  if (recheck?.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
    );
  }

  try {
    const { url } = await createHostedPageSale({
      amountUsd: invoice.balance,
      orderRef,
      successUrl,
      failureUrl,
      customerEmail: quote.customer_email,
      customerName: quote.customer_name,
      orderDescription: 'Yule Love Lights balance',
    });
    return NextResponse.json({ ok: true, redirectUrl: url, amountUsd: invoice.balance, orderRef });
  } catch (err) {
    const msg = err instanceof ValorError ? err.message : err instanceof Error ? err.message : 'Unknown Valor error';
    console.error('[api/quotes/:id/pay-balance] createHostedPageSale failed:', msg);
    return NextResponse.json(
      { error: 'Could not start payment. Please try again.', code: 'hosted-page-failed' },
      { status: 502 },
    );
  }
}
