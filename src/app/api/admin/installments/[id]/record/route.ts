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
//
// THE LINKED INVOICE DOES NOT MOVE. `invoices.balance` and `deposit_applied` are
// stored figures snapshotted when the invoice was created — recording a payment
// here raises the quote's collected total and leaves the invoice saying the
// customer still owes the old amount, on `/admin/invoices` and on the owner's
// dashboard. The runner already refuses to CHARGE into that state
// (`invoiceDriftBlockers`); this route must not silently walk into it either.
// But a cash payment must always be recordable — refusing outright would strand
// real money — so it asks for `confirmInvoiceDrift: true` and says exactly which
// invoice will be wrong and by how much. Wiring the invoice side is ledger row
// 450. Found by the premerge admin lens; today this is live for exactly one
// customer, Jane Laguerre's draft invoice #1010.
//
// WHO DID IT. `paid_by` records the operator, mirroring `invoices.settled_by` on
// the sibling manual settle. A money write with no actor is not auditable.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { markInstallmentPaid } from '@/lib/installments';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { describeChargeSlot } from '@/lib/integrations/valorBalance';
import { isAmbiguousTimeoutMarker, invoiceDriftBlockers } from '@/lib/installmentRunner';

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
    confirmInvoiceDrift?: unknown;
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
    .select('id, quote_id, seq, paid_at, valor_txn_id, amount_usd')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 503 });
  if (!row) return NextResponse.json({ error: 'No such scheduled payment' }, { status: 404 });

  const inst = row as {
    id: string;
    quote_id: string;
    seq: number;
    paid_at: string | null;
    valor_txn_id: string | null;
    amount_usd: number | string;
  };
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

  // The invoice this payment will leave behind. Same predicate the runner uses,
  // so the two paths cannot disagree about what counts as drift.
  if (input.confirmInvoiceDrift !== true) {
    const { data: invoices, error: invErr } = await sb
      .from('invoices')
      .select('id, quote_id, invoice_number, status, balance')
      .eq('quote_id', inst.quote_id);
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 503 });
    const rows = (invoices ?? []) as {
      id: string;
      quote_id: string | null;
      invoice_number: number | null;
      status: string;
      balance: number | string | null;
    }[];
    const blocked = invoiceDriftBlockers(rows);
    if (blocked.has(inst.quote_id)) {
      const inv = rows.find((r) => r.quote_id === inst.quote_id && r.status !== 'paid' && r.status !== 'cancelled');
      const amount = Number(inst.amount_usd);
      const stale = Number(inv?.balance ?? 0);
      return NextResponse.json(
        {
          error:
            `Recording this will raise what the customer has paid, but invoice #${inv?.invoice_number ?? '?'} will still ` +
            `say $${stale.toFixed(2)} is owed instead of $${(stale - amount).toFixed(2)} — its balance is a stored figure ` +
            `and nothing updates it yet (ledger row 450). The invoice list and the dashboard will be wrong by ` +
            `$${amount.toFixed(2)} until someone fixes it by hand. Record the payment anyway?`,
          code: 'invoice-would-drift',
          invoiceNumber: inv?.invoice_number ?? null,
          staleBalanceUsd: stale,
          amountUsd: amount,
        },
        { status: 409 },
      );
    }
  }

  const operator = await getOperator();
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
    paidBy: operator?.id ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  return NextResponse.json({ ok: true, amountUsd: result.amountUsd });
}
