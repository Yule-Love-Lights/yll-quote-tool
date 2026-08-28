// POST /api/admin/installments/[id]/record   (operator-only)
//
// Record a scheduled installment payment that has ALREADY been collected —
// cash, a check, a card charge taken in Valor by hand, or a charge the runner
// made but could not finish recording. Ledger row 446.
//
// THIS NEVER CHARGES ANYTHING. It moves `installments.paid_at` and the quote's
// collected total together, through `markInstallmentPaid`'s compare-and-swap, so
// the plan and the quote can never drift apart. Collecting the money is a
// separate, deliberate act that happened before this call.
//
// WHY IT EXISTS. `markInstallmentPaid` shipped with no caller anywhere in the
// app, so a payment the runner charged but failed to record — an ambiguous Valor
// timeout, a lost CAS race — could only be fixed by a developer editing the
// database. The runner (row 448) must not be armed until this exists, which is
// written into its own header.
//
// CLEARING A CHARGE SLOT. An installment whose `valor_txn_id` holds a `pending:`
// claim or an `ambiguous-timeout:` marker is one where a charge MAY have landed
// at Valor. Recording it as paid is exactly the right resolution once a human
// has checked Valor and found the charge — so this route accepts it, and asks
// for `confirmChargeSlot: true` first, so the acknowledgement is explicit rather
// than a click that silently overwrites an unknown.

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { markInstallmentPaid } from '@/lib/installments';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { describeChargeSlot } from '@/lib/integrations/valorBalance';
import { isAmbiguousTimeoutMarker } from '@/lib/installmentRunner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCES = new Set(['manual', 'valor']);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: 'Missing installment id' }, { status: 400 });

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const input = (body ?? {}) as {
    source?: unknown;
    valorTxnId?: unknown;
    confirmChargeSlot?: unknown;
  };

  // 'manual' (cash/check) or 'valor' (a card charge taken by hand). 'homeworks'
  // is deliberately not accepted: it means "collected before the migration" and
  // is only ever written by the migration itself.
  const source = typeof input.source === 'string' ? input.source : 'manual';
  if (!SOURCES.has(source)) {
    return NextResponse.json({ error: `Unknown payment source '${source}'` }, { status: 400 });
  }
  const valorTxnId = typeof input.valorTxnId === 'string' && input.valorTxnId.trim() ? input.valorTxnId.trim() : null;

  const sb = getSupabaseServiceClient();
  if (!sb) return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });

  const { data: row, error: readErr } = await sb
    .from('installments')
    .select('id, paid_at, valor_txn_id, amount_usd')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 503 });
  if (!row) return NextResponse.json({ error: 'No such scheduled payment' }, { status: 404 });

  const inst = row as { id: string; paid_at: string | null; valor_txn_id: string | null; amount_usd: number | string };
  if (inst.paid_at) {
    return NextResponse.json(
      { error: 'That payment is already recorded as paid', code: 'already-paid' },
      { status: 409 },
    );
  }

  // A non-empty charge slot means a charge may already have gone through and
  // nobody knows the outcome. Refuse ONCE, say what is in the slot, and let the
  // operator confirm — this is the only exit from that state, so it must exist,
  // but it must never be a single unthinking click.
  const slot = describeChargeSlot(inst.valor_txn_id);
  if (slot.kind !== 'none' && input.confirmChargeSlot !== true) {
    return NextResponse.json(
      {
        error:
          'A charge attempt is recorded against this payment and its outcome is unknown. Check Valor for this customer, ' +
          'amount and date first. If the money did arrive, confirm to record it; if it did not, clear the attempt instead.',
        code: 'charge-slot-unresolved',
        slot,
      },
      { status: 409 },
    );
  }

  const result = await markInstallmentPaid({
    installmentId: id,
    paidAt: new Date(),
    source: source as 'manual' | 'valor',
    // Preserve a REAL Valor reference already in the slot when the caller does
    // not supply one; never preserve an `ambiguous-timeout:` marker, which is
    // not a reference and must not survive into the paid record.
    valorTxnId:
      valorTxnId ??
      (slot.kind === 'charged' && !isAmbiguousTimeoutMarker(slot.txnId) ? slot.txnId : null),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  return NextResponse.json({ ok: true, amountUsd: result.amountUsd });
}
