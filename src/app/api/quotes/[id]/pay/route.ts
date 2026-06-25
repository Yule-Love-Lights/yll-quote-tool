// Start the customer's 50% deposit payment via Valor's HOSTED payment page (#38).
//
// POST /api/quotes/[id]/pay
// Body: none required (the amount is taken from the frozen approval snapshot,
//       NOT from the client — we never let the browser dictate what we charge).
// Response:
//   { ok: true, redirectUrl, amountUsd, orderRef }
//   { error: string, code?: string }
//
// Flow context: the customer clicks Approve (which freezes the approval
// snapshot), then the checkout calls this endpoint. We ask Valor for a HOSTED
// payment page and return its URL; the browser redirects there, the customer
// pays on Valor's own page (card never touches our server → SAQ-A), and Valor
// returns them to success_url/failure_url. Valor's webhook — not this call —
// is what actually marks the quote booked.
//
// Idempotency: a quote already paid returns 409. Re-opening the checkout for an
// unpaid quote reuses the same valor_order_ref so the webhook mapping is stable.

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { rateLimitResponse } from '@/lib/rateLimit';
import { createHostedPageSale, isValorConfigured, ValorError } from '@/lib/integrations/valor';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  valor_order_ref: string | null;
  approval_snapshot: { customerSelection?: { currentDepositUsd?: number } } | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-pay', limit: 10, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  if (!isValorConfigured()) {
    // Build-time / pre-credentials state: surface a clear, non-fatal signal the
    // checkout UI can show ("payment isn't set up yet") instead of a 500.
    return NextResponse.json(
      { error: 'Payment processing is not configured yet', code: 'valor-not-configured' },
      { status: 503 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_email, customer_approved_at, deposit_paid_at, valor_order_ref, approval_snapshot',
    )
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Already paid — nothing to charge again.
  if (quote.deposit_paid_at) {
    return NextResponse.json(
      { error: 'Deposit already paid', code: 'already-paid', paidAt: quote.deposit_paid_at },
      { status: 409 },
    );
  }

  // The deposit must come from the snapshot the customer just approved — that's
  // the server's authoritative record of what they agreed to. No snapshot means
  // Approve hasn't run yet.
  const depositUsd = quote.approval_snapshot?.customerSelection?.currentDepositUsd;
  if (!quote.customer_approved_at || typeof depositUsd !== 'number' || depositUsd <= 0) {
    return NextResponse.json(
      { error: 'Quote must be approved before payment', code: 'approve-first' },
      { status: 409 },
    );
  }

  // Stable reference echoed back by Valor's webhook (as the invoicenumber) so it
  // can find this quote. Reuse an existing one (re-opened checkout) to keep the
  // mapping stable.
  const orderRef = quote.valor_order_ref ?? `q${randomBytes(8).toString('hex')}`;

  // Record the reference + the amount we're about to ask Valor to charge, before
  // we send the customer to the hosted page — so the webhook can verify the
  // confirmed amount against what we intended.
  const { error: stampErr } = await sb
    .from('quotes')
    .update({ valor_order_ref: orderRef, deposit_amount_usd: depositUsd })
    .eq('id', id);
  if (stampErr) {
    console.error('[api/quotes/:id/pay] order-ref stamp failed:', stampErr);
    return NextResponse.json(
      { error: `Failed to start checkout: ${stampErr.message}` },
      { status: 500 },
    );
  }

  // Where Valor returns the customer after they pay (or fail/cancel). The
  // booked page is gated to an approved quote; the portal page lets them retry.
  const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
  const successUrl = `${baseUrl}/portal/${id}/approved`;
  const failureUrl = `${baseUrl}/portal/${id}`;

  try {
    const { url } = await createHostedPageSale({
      amountUsd: depositUsd,
      orderRef,
      successUrl,
      failureUrl,
      customerEmail: quote.customer_email,
      customerName: quote.customer_name,
    });
    return NextResponse.json({ ok: true, redirectUrl: url, amountUsd: depositUsd, orderRef });
  } catch (err) {
    const msg =
      err instanceof ValorError ? err.message : err instanceof Error ? err.message : 'Unknown Valor error';
    console.error('[api/quotes/:id/pay] createHostedPageSale failed:', msg);
    return NextResponse.json(
      { error: 'Could not start payment. Please try again.', code: 'hosted-page-failed' },
      { status: 502 },
    );
  }
}
