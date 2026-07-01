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

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteForBooking = {
  id: string;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  total: number | null;
  is_test: boolean;
  // Set by /api/quotes/[id]/pay when a customer Valor hosted-page checkout is
  // initiated, BEFORE deposit_paid_at is stamped by the webhook. A non-null
  // value with deposit_paid_at still null means a card payment is in flight.
  valor_order_ref: string | null;
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
    .select('id, customer_approved_at, deposit_paid_at, total, is_test, valor_order_ref')
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

  // Clamp the deposit so we can't record more than the quote total. A null
  // total (a malformed / edge row — an approved quote virtually always has a
  // total) is intentionally left unclamped: with no total to clamp against, we
  // record the operator-entered amount as-is rather than silently zeroing it.
  const clamped = typeof quote.total === 'number' ? Math.min(depositUsd, quote.total) : depositUsd;
  const bookedAt = new Date().toISOString();

  // Atomic booking write: .is('deposit_paid_at', null) is the concurrency guard.
  // If a concurrent request already wrote deposit_paid_at, this returns 0 rows
  // and we fall through to the idempotent already-booked path below.
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({ deposit_paid_at: bookedAt, deposit_amount_usd: clamped, status: 'booked' })
    .eq('id', id)
    .is('deposit_paid_at', null)
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
