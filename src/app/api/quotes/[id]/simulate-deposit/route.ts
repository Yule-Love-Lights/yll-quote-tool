// Simulate a deposit payment for a TEST quote (ledger #93). OPERATOR-ONLY.
//
// POST /api/quotes/[id]/simulate-deposit
// Body: none — the quote id is in the URL.
// Response: { ok: true, booked: true, simulated: true, paidAt } | { error, code? }
//
// A test quote never touches Valor. Instead of a real hosted-page charge, the
// portal renders "Simulate deposit paid", which calls this route. It mirrors the
// Valor webhook's booking path EXACTLY — atomic claim on deposit_paid_at →
// status='booked' → createJobFromQuote — so a TEST Job appears and flows into the
// fulfillment Kanban. But there is NO card charge, NO receipt, and NO auto-PO
// trigger (a test job must never reach the real supplier order).
//
// Guards:
//   - operator-only (requireOperator, dormant until AUTH_GATE_ENABLED) — this is
//     a staff testing tool, never a customer-reachable endpoint, so it is NOT in
//     the operatorGate public allowlist.
//   - REFUSES a non-test quote (400) so it can never bypass a real deposit.
//   - idempotent: the atomic claim + createJobFromQuote's own one-job-per-quote
//     guard make concurrent / repeated clicks safe.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { createJobFromQuote } from '@/lib/jobs';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  is_test: boolean;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  deposit_amount_usd: number | null;
  approval_snapshot: { customerSelection?: { currentDepositUsd?: number } } | null;
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

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, is_test, customer_approved_at, deposit_paid_at, deposit_amount_usd, approval_snapshot')
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // HARD GUARD: this route only ever touches TEST data. Refusing a real quote
  // here means it can never be used to skip a real Valor deposit.
  if (!quote.is_test) {
    return NextResponse.json(
      { error: 'Not a test quote — refusing to simulate a deposit', code: 'not-test' },
      { status: 400 },
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
