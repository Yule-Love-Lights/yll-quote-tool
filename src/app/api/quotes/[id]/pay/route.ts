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
import { deriveStatus } from '@/lib/quoteStatus';

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
  // Explicit lifecycle status (ledger #83) — used to refuse a dead (cancelled /
  // declined / abandoned) quote before it can mint a hosted page (W1-007).
  status: import('@/lib/quoteStatus').QuoteStatus | null;
  // Test Quote (ledger #93): a simulated quote must never reach real Valor.
  is_test: boolean;
  // View-only portal (#176): a staff-flagged browse-only quote can never
  // start a real checkout — see the check right after the fetch below.
  view_only: boolean;
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
      'id, customer_name, customer_email, customer_approved_at, deposit_paid_at, valor_order_ref, approval_snapshot, status, is_test, view_only',
    )
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // View-only portal (#176): a staff-flagged browse-only quote must never
  // reach real Valor (or the simulate-deposit flow, but that route is
  // unaffected by this task) — server hard-guard, checked before any write
  // or Valor call. The portal UI's matching gate is StickyBottomBar's
  // viewOnly branch (DepositCheckout is never mounted).
  if (quote.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
    );
  }

  // Test Quote (#93): a simulated quote never touches real Valor — the portal
  // renders "Simulate deposit paid" (→ /simulate-deposit) instead. Refuse here
  // as defense in depth so a test quote can never mint a real hosted-page charge.
  if (quote.is_test) {
    return NextResponse.json(
      { error: 'Test quote: use the simulate-deposit flow', code: 'test-quote' },
      { status: 400 },
    );
  }

  // Already paid — nothing to charge again.
  if (quote.deposit_paid_at) {
    return NextResponse.json(
      { error: 'Deposit already paid', code: 'already-paid', paidAt: quote.deposit_paid_at },
      { status: 409 },
    );
  }

  // W1-007: a dead quote (cancelled / declined / abandoned) must not be able to mint a
  // hosted page — otherwise a customer holding a live pay link could pay against a
  // cancelled order and the webhook would resurrect it to 'booked'. Gate here so a
  // terminal quote can't even start checkout (the webhook adds the matching guard
  // on the booking write). deriveStatus returns the persisted terminal status; a
  // live approved-unbooked quote derives 'approved'.
  const lifecycleStatus = deriveStatus({
    quote_sent_at: null,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    status: quote.status,
  });
  if (lifecycleStatus === 'cancelled' || lifecycleStatus === 'declined' || lifecycleStatus === 'abandoned') {
    return NextResponse.json(
      { error: `This quote is ${lifecycleStatus} and can no longer be paid`, code: 'not-payable' },
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
  let orderRef = quote.valor_order_ref ?? `q${randomBytes(8).toString('hex')}`;

  // W1-015 — GUARDED first-time stamp. An unguarded read-then-write let two
  // concurrent first opens (same portal link on two tabs/devices) both mint a
  // ref and overwrite each other → the customer pays on a hosted page carrying a
  // ref the webhook can't map (charged but never booked), and it could also clobber
  // a webhook-recorded ACTUAL deposit with the intended amount. So we stamp the
  // ref + intended amount ONLY when the ref is still null AND unpaid; if the row
  // already carries a ref we reuse it untouched (no re-stamp).
  if (!quote.valor_order_ref) {
    // View-only portal (#176 TOCTOU): the early view_only check above is a
    // fast-path 409; `.eq('view_only', false)` re-checks it in the write
    // itself so a concurrent staff toggle can't be raced past (view_only is
    // NOT NULL, so a plain `.eq` is safe — no W1-014 NULL trap here).
    const { data: claimed, error: stampErr } = await sb
      .from('quotes')
      .update({ valor_order_ref: orderRef, deposit_amount_usd: depositUsd })
      .eq('id', id)
      .eq('view_only', false)
      .is('valor_order_ref', null)
      .is('deposit_paid_at', null)
      .select('id');
    if (stampErr) {
      console.error('[api/quotes/:id/pay] order-ref stamp failed:', stampErr);
      return NextResponse.json(
        { error: `Failed to start checkout: ${stampErr.message}` },
        { status: 500 },
      );
    }
    // Lost the race (0 rows) — a concurrent open won, or the deposit just got
    // paid. Re-read and reuse the winner's ref so the hosted page maps back;
    // 409 if it's now paid.
    if (!claimed || claimed.length === 0) {
      const { data: fresh } = await sb
        .from('quotes')
        .select('valor_order_ref, deposit_paid_at')
        .eq('id', id)
        .single<{ valor_order_ref: string | null; deposit_paid_at: string | null }>();
      if (fresh?.deposit_paid_at) {
        return NextResponse.json(
          { error: 'Deposit already paid', code: 'already-paid', paidAt: fresh.deposit_paid_at },
          { status: 409 },
        );
      }
      if (fresh?.valor_order_ref) {
        orderRef = fresh.valor_order_ref;
      }
    }
  }

  // Where Valor returns the customer after they pay (or fail/cancel). The
  // booked page is gated to an approved quote; the portal page lets them retry.
  // #166: `?confirming=1` marks a just-paid deposit return so /approved can show
  // a "confirming your payment" pending state until the async webhook writes
  // deposit_paid_at — otherwise the customer briefly sees the pre-booked variant.
  // Same round-trips-through-Valor pattern the pay-balance successUrl uses.
  const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
  const successUrl = `${baseUrl}/portal/${id}/approved?confirming=1`;
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
