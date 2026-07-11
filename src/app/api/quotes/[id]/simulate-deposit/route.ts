// Simulate a deposit payment for a TEST quote (ledger #93).
//
// POST /api/quotes/[id]/simulate-deposit
// Body: none — the quote id is in the URL.
// Response: { ok: true, booked: true, simulated: true, paidAt } | { error, code? }
//
// A test quote never touches Valor. Instead of a real hosted-page charge, the
// portal renders "Simulate deposit paid" on the ANONYMOUS customer portal
// (DepositCheckout.tsx calls this route directly, unauthenticated, for a quote
// with is_test===true) — so this route follows the SAME capability-token auth
// model as /approve and /pay: the quote id is the token, no operator session
// required (#81 W6-008; it is allowlisted as a PUBLIC_QUOTE_SUBROUTE). It mirrors
// the Valor webhook's booking path EXACTLY — atomic claim on deposit_paid_at →
// status='booked' → createJobFromQuote — so a TEST Job appears and flows into the
// fulfillment Kanban. But there is NO card charge, NO receipt, and NO auto-PO
// trigger (a test job must never reach the real supplier order).
//
// Guards:
//   - HARD, non-bypassable is_test===true check, checked FIRST after the quote
//     loads — an anonymous caller can therefore only ever affect a test quote. A
//     real (non-test) quote is refused with 403 before anything else runs, so
//     this route can never be used to skip or fake a real deposit.
//   - idempotent: the atomic claim + createJobFromQuote's own one-job-per-quote
//     guard make concurrent / repeated clicks safe.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { createJobFromQuote } from '@/lib/jobs';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { accrueOnBooking, ensureReferralCode } from '@/lib/referrals';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  is_test: boolean;
  // #124: persisted status so a declined quote (approved→declined keeps
  // customer_approved_at set) can't be re-booked here. deriveStatus reads it.
  status: QuoteStatus | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  deposit_amount_usd: number | null;
  approval_snapshot: { customerSelection?: { currentDepositUsd?: number } } | null;
  // Referral program (#41): the quote's OWN linked customer (if any), so a
  // booking here can stamp their referral code (see the ensureReferralCode
  // call below). Always null in practice for a TEST quote — saveQuote never
  // links a test quote's customer_id — but selected + guarded anyway for
  // consistency with the other two booking sites.
  customer_id: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, is_test, status, customer_approved_at, deposit_paid_at, deposit_amount_usd, approval_snapshot, customer_id')
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // HARD GUARD (#81 W6-008): this route is reachable by an unauthenticated
  // customer-portal caller, so this check IS the auth boundary — it must run
  // before anything else and must never be bypassable. Refusing a real quote
  // here means an anon caller can never use this route to skip or fake a real
  // deposit. 403 (not 400): this isn't a bad request, it's "you may not do this
  // to this quote."
  if (!quote.is_test) {
    return NextResponse.json(
      { error: 'Not a test quote — refusing to simulate a deposit', code: 'not-test' },
      { status: 403 },
    );
  }

  // A deposit only makes sense after approval — mirrors the real /pay gate (and
  // the portal only shows the simulate button on an approved-not-booked quote).
  if (!quote.customer_approved_at) {
    return NextResponse.json(
      { error: 'Quote must be approved before the deposit', code: 'approve-first' },
      { status: 409 },
    );
  }

  // Already simulated — idempotent no-op.
  if (quote.deposit_paid_at) {
    return NextResponse.json({ ok: true, booked: true, alreadyPaid: true, simulated: true });
  }

  // #124 money-safety: refuse to book a DEAD quote (declined / cancelled / lost) —
  // same guard as convert-to-job + /pay (W1-007). approved→declined is now legal, so
  // a declined test quote can carry customer_approved_at (passing the approve gate
  // above) while status='declined'; without this it would be re-booked (declined→booked).
  const lifecycle = deriveStatus({
    status: quote.status,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    quote_sent_at: null,
    viewed_at: null,
  });
  if (lifecycle === 'declined' || lifecycle === 'cancelled' || lifecycle === 'lost') {
    return NextResponse.json(
      { error: `Cannot book a ${lifecycle} quote`, code: 'not-bookable' },
      { status: 409 },
    );
  }

  // Amount recorded for parity with the real flow (the snapshot is what the
  // customer "agreed to"); falls back to the stored amount, else 0.
  const depositUsd =
    quote.approval_snapshot?.customerSelection?.currentDepositUsd ?? quote.deposit_amount_usd ?? 0;

  // ATOMIC CLAIM (same as the Valor webhook): conditional on deposit_paid_at IS
  // NULL so concurrent clicks can't double-book. A synthetic txn marker makes the
  // row visibly a simulated payment — no vault token / receipt / approval code.
  const paidAt = new Date().toISOString();
  const { data: claimed, error: stampErr } = await sb
    .from('quotes')
    .update({
      deposit_paid_at: paidAt,
      status: 'booked',
      deposit_amount_usd: depositUsd,
      valor_txn_id: 'SIMULATED-TEST',
    })
    .eq('id', id)
    .is('deposit_paid_at', null)
    .or('status.not.in.(declined,cancelled,lost),status.is.null')
    .select('id');

  if (stampErr) {
    console.error('[api/quotes/:id/simulate-deposit] paid stamp failed:', stampErr);
    return NextResponse.json(
      { error: `Failed to record simulated deposit: ${stampErr.message}` },
      { status: 500 },
    );
  }
  if (!claimed || claimed.length === 0) {
    // Lost the race to a concurrent click — already booked.
    return NextResponse.json({ ok: true, booked: true, alreadyPaid: true, simulated: true });
  }

  // Referral program (#41): same booking-event accrual the real Valor webhook
  // fires — mirrors this route's own "SAME path" contract. Best-effort (belt-
  // and-suspenders; accrueOnBooking already fails open internally).
  try {
    await accrueOnBooking(id);
  } catch (err) {
    console.error('[api/quotes/:id/simulate-deposit] referral accrual failed:', err);
  }

  // Referral program (#41 PR 2): stamp THIS quote's own customer with their
  // referral code (+ GHL link) at the booking event, not only when they later
  // view the booked page — so every customer has their link live by install
  // day. Fail-open (ensureReferralCode already tolerates a missing customer/
  // config internally); wrapped anyway to match this route's belt-and-
  // suspenders style for every booking side effect.
  try {
    if (quote.customer_id) await ensureReferralCode(quote.customer_id);
  } catch (err) {
    console.error('[api/quotes/:id/simulate-deposit] referral code stamp failed:', err);
  }

  // Auto-create the (test) Job — the SAME idempotent path the Valor webhook uses,
  // so the test quote flows into the fulfillment Kanban. The job derives is_test
  // via its quote link. Best-effort: a failure must not undo the recorded
  // booking. Deliberately NO auto-PO trigger (test jobs never order real stock).
  try {
    await createJobFromQuote(id);
  } catch (err) {
    console.error('[api/quotes/:id/simulate-deposit] job auto-create failed:', err);
  }

  return NextResponse.json({ ok: true, booked: true, simulated: true, paidAt });
}
