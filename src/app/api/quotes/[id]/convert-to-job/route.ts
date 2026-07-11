// Operator-triggered quote booking — records a manual deposit and converts an
// approved quote to a job.
//
// POST /api/quotes/[id]/convert-to-job   (operator-only)
// Body: { depositUsd: number, force?: boolean }
//   depositUsd — the deposit the customer paid offline (>= 0). 0 is valid (a
//     deferred/waived deposit). The amount is clamped to the quote total so we
//     can never record a deposit greater than the order.
//   force — operator override for the payment-in-flight guard. When a customer
//     STARTED but ABANDONED a Valor checkout, valor_order_ref stays set forever
//     and would permanently block manual booking. force:true bypasses that guard
//     (the operator has confirmed no payment landed). It NEVER bypasses the
//     already-booked idempotency branch — a genuinely-paid quote is still safe.
// Response: { ok, booked, depositUsd, jobId } | { ok, alreadyBooked } | { error, code? }
//
// NO Valor charge here — this is a local status record only. The operator
// calls this after collecting the deposit by other means (cash / check /
// Valor terminal) or when converting an already-informally-approved deal to
// a job without a deposit.
//
// Money-safety invariants:
//   - depositUsd must be a finite number >= 0 (400 otherwise)
//   - depositUsd is clamped to quote.total (can't over-record a deposit)
//   - The booking write is atomic: .is('deposit_paid_at', null) ensures a
//     concurrent double-click or retry can never double-write. The loser of
//     the race receives 0 updated rows → treated as an idempotent alreadyBooked.
//   - Not-yet-approved quotes are blocked (409, code: 'not-approved').
//   - createJobFromQuote is idempotent on quote_id — safe to call on retry.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { createJobFromQuote } from '@/lib/jobs';
import { resolveAgreedTotal, type AgreedTotalSnapshot } from '@/lib/agreedTotal';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { accrueOnBooking, ensureReferralCode } from '@/lib/referrals';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteForBooking = {
  id: string;
  // #124: the persisted lifecycle status — needed so a quote the operator later
  // DECLINED (approved→declined is now legal, keeping customer_approved_at set)
  // can't be re-booked here. deriveStatus reads it.
  status: QuoteStatus | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  total: number | null;
  is_test: boolean;
  // W1-043: the approved SELECTION total (+ any amendment) — the AGREED figure to
  // clamp the deposit against, which can diverge from the full quote.total.
  approval_snapshot: AgreedTotalSnapshot;
  // Set by /api/quotes/[id]/pay when a customer Valor hosted-page checkout is
  // initiated, BEFORE deposit_paid_at is stamped by the webhook. A non-null
  // value with deposit_paid_at still null means a card payment is in flight.
  valor_order_ref: string | null;
  // Referral program (#41 PR 2): the quote's OWN linked customer (if any), so
  // this manual booking can stamp their referral code too (see below).
  customer_id: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  // Parse + validate the deposit amount up front.
  let body: { depositUsd?: unknown; force?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const depositUsd = Number(body.depositUsd);
  if (!Number.isFinite(depositUsd) || depositUsd < 0) {
    return NextResponse.json({ error: 'depositUsd must be a finite number >= 0' }, { status: 400 });
  }
  const force = body.force === true;

  const sb = getSupabaseServiceClient()!;
  const { data: quote } = await sb
    .from('quotes')
    .select('id, status, customer_approved_at, deposit_paid_at, total, is_test, approval_snapshot, valor_order_ref, customer_id')
    .eq('id', id)
    .maybeSingle<QuoteForBooking>();

  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // Idempotency: already booked — return the existing state without any write.
  if (quote.deposit_paid_at) {
    const job = await createJobFromQuote(id); // idempotent on quote_id
    return NextResponse.json({ ok: true, alreadyBooked: true, jobId: job?.id ?? null });
  }

  // #124 money-safety: a DEAD quote (declined / cancelled / lost) must never be
  // booked here — mirrors the /pay W1-007 guard. This route gates on the raw
  // customer_approved_at column, but #124 makes approved→declined legal, so a
  // declined quote can now carry customer_approved_at while status='declined'
  // (deposit unpaid). Without this, a direct POST would re-book it (declined→booked,
  // which canTransition forbids). deriveStatus returns the persisted terminal status.
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

  // Gate: only approved quotes can be converted to a job.
  if (!quote.customer_approved_at) {
    return NextResponse.json(
      { error: 'Quote must be approved before converting to a job', code: 'not-approved' },
      { status: 409 },
    );
  }

  // Money-safety: refuse to manual-book while a customer Valor checkout is in
  // flight. /api/quotes/[id]/pay stamps valor_order_ref before the customer
  // completes the hosted-page deposit; the Valor webhook then books the quote
  // via the SAME .is('deposit_paid_at', null) atomic claim this route uses. If
  // we won that claim mid-checkout, the webhook would short-circuit as
  // "alreadyPaid" and DROP the real payment (no valor_txn_id/receipt stored,
  // and deposit_amount_usd left at the operator-typed value → the later invoice
  // over-bills). Surfacing the ambiguity to the operator is the conservative
  // choice: they confirm it settled (or reconcile in Valor) before booking by
  // hand. A started-but-abandoned checkout also lands here — but that would
  // permanently dead-end manual booking (valor_order_ref never clears itself), so
  // an operator who has confirmed no payment landed can pass force:true to bypass
  // this guard and book by hand. force only reaches here AFTER the already-booked
  // branch above, so it can never override a genuinely-paid quote.
  if (quote.valor_order_ref && !force) {
    return NextResponse.json(
      {
        error:
          'A customer card payment is in progress for this quote — confirm it settled (or reconcile in Valor) before booking manually.',
        code: 'payment-in-flight',
      },
      { status: 409 },
    );
  }

  // Clamp the deposit so we can't record more than the AGREED total (W1-043) — the
  // customer approves a SELECTION that can be cheaper than the full quote.total, so
  // clamp against approval_snapshot.customerSelection.currentTotalUsd (+ any
  // amendment) when present, falling back to quote.total. A null total on a legacy
  // row with no snapshot is intentionally left unclamped: with nothing to clamp
  // against, record the operator-entered amount as-is rather than silently zeroing
  // it. (quote.total mirrors result.total — updateQuote writes total: result.total.)
  const agreedTotal =
    quote.approval_snapshot || typeof quote.total === 'number'
      ? resolveAgreedTotal(quote.approval_snapshot, { total: quote.total })
      : null;
  const clamped = agreedTotal !== null ? Math.min(depositUsd, agreedTotal) : depositUsd;
  const bookedAt = new Date().toISOString();

  // Atomic booking write: .is('deposit_paid_at', null) is the concurrency guard.
  // If a concurrent request already wrote deposit_paid_at, this returns 0 rows
  // and we fall through to the idempotent already-booked path below. The status
  // .or(...) clause (#124) closes the TOCTOU where the quote is declined/cancelled
  // between our SELECT and this write — mirrors the approve route's booking guard.
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({ deposit_paid_at: bookedAt, deposit_amount_usd: clamped, status: 'booked' })
    .eq('id', id)
    .is('deposit_paid_at', null)
    .or('status.not.in.(declined,cancelled,lost),status.is.null')
    .select('id');

  if (error) {
    console.error('[api/quotes/:id/convert-to-job] booking write failed:', error);
    return NextResponse.json({ error: 'Failed to book the quote' }, { status: 500 });
  }

  if (!claimed || claimed.length === 0) {
    // Race loser: another concurrent request already booked this quote.
    const job = await createJobFromQuote(id); // idempotent — return the existing job
    return NextResponse.json({ ok: true, alreadyBooked: true, jobId: job?.id ?? null });
  }

  // Referral program (#41): this manual/operator booking write is a THIRD
  // deposit-paid write site (found by reconciling every writer of deposit_paid_at
  // — see AGENTS.md pitfall on cross-cutting seams), so it needs the same
  // accrual the Valor webhook + simulate-deposit fire. Best-effort — must never
  // block an operator's manual booking.
  try {
    await accrueOnBooking(id);
  } catch (err) {
    console.error('[api/quotes/:id/convert-to-job] referral accrual failed:', err);
  }

  // Referral program (#41 PR 2): stamp THIS quote's own customer with their
  // referral code (+ GHL link) at the booking event, not only when they later
  // view the booked page — so every customer has their link live by install
  // day. Fail-open — must never block an operator's manual booking.
  try {
    if (quote.customer_id) await ensureReferralCode(quote.customer_id);
  } catch (err) {
    console.error('[api/quotes/:id/convert-to-job] referral code stamp failed:', err);
  }

  // We won the race. Create the job (idempotent on quote_id — a test job for a
  // test quote, per #93; a real job otherwise).
  const job = await createJobFromQuote(id);
  return NextResponse.json({
    ok: true,
    booked: true,
    depositUsd: clamped,
    jobId: job?.id ?? null,
  });
}
