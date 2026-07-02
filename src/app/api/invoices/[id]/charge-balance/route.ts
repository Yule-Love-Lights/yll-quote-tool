// POST /api/invoices/[id]/charge-balance  (operator-only)
//
// Operator-triggered "Charge remaining balance" — charge the card saved at
// deposit (quotes.valor_vault_token) for the invoice's EXACT balance, no customer
// present (ledger #83). This is the manual (staff-clicks-when-ready) counterpart
// to the customer pay-link; it is NOT auto-on-complete.
//
// GATED: the real charge lives in chargeBalanceOnFile, which is a STUB behind
// VALOR_AUTO_CHARGE_ENABLED (returns 'not-enabled' until Valor's server-initiated
// card-on-file capability is confirmed + wired — see
// docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md). Until then this route never
// moves money: it validates + returns a non-ok reason, and the operator UI hides
// the button (the flag is echoed by GET /api/invoices/[id]).
//
// ⚠️ IDEMPOTENCY (for Jason when wiring the real charge): a double-click could fire
// two charges before the first settles. The settle here is atomic (.neq
// status,'paid'), but the CHARGE is not — add a Valor duplicate_transaction_check
// (invoicenumber = bal_<quoteId>) or a pre-claim guard when the real POST /?saleToken
// call lands. The UI disables the button mid-request as a first-line mitigation.
//
// Amount = the invoice balance ONLY (not an arbitrary operator amount). To change
// the amount, amend the order (which re-prices the balance) — partial/arbitrary
// charges are not modelled on the invoice.
//
// Response: { ok, charged, invoice } | { ok:false, reason, error }

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoice, markInvoicePaidManually } from '@/lib/invoices';
import { getJob, setJobStatus } from '@/lib/jobs';
import { planBalanceCollection } from '@/lib/balanceCollection';
import { chargeBalanceOnFile, isAutoChargeEnabled } from '@/lib/integrations/valorBalance';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteCardRow = {
  valor_vault_token: string | null;
  customer_name: string | null;
  customer_email: string | null;
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

  // Gate: no auto-charge capability confirmed → don't attempt anything.
  if (!isAutoChargeEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'not-enabled',
        error: 'Auto-charge is not enabled yet. Collect the balance via the customer pay-link.',
      },
      { status: 503 },
    );
  }

  const invoice = await getInvoice(id);
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }
  if (invoice.status === 'cancelled') {
    return NextResponse.json({ ok: false, reason: 'cancelled', error: 'This invoice was cancelled' }, { status: 400 });
  }
  if (invoice.status === 'paid' || invoice.balance <= 0) {
    return NextResponse.json({ ok: false, reason: 'no-balance', error: 'No balance due' }, { status: 409 });
  }
  if (!invoice.quote_id) {
    return NextResponse.json({ ok: false, reason: 'no-quote', error: 'Invoice has no linked quote' }, { status: 409 });
  }

  // The saved card + customer live on the quote.
  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: qErr } = await sb
    .from('quotes')
    .select('valor_vault_token, customer_name, customer_email')
    .eq('id', invoice.quote_id)
    .single<QuoteCardRow>();
  if (qErr || !quote) {
    return NextResponse.json({ ok: false, reason: 'no-quote', error: 'Linked quote not found' }, { status: 409 });
  }

  const plan = planBalanceCollection({
    balance: invoice.balance,
    creditNote: invoice.credit_note,
    hasVaultToken: !!quote.valor_vault_token,
  });
  if (plan.method === 'none') {
    // overpaid → manual Valor refund; no_balance already guarded above.
    return NextResponse.json(
      { ok: false, reason: 'overpaid', error: 'Nothing to charge (overpaid — refund manually in Valor)' },
      { status: 409 },
    );
  }
  if (plan.method === 'pay_link') {
    // No saved card on file → can't auto-charge; the operator must send the pay-link.
    return NextResponse.json(
      { ok: false, reason: 'no-card', error: 'No saved card on file. Send the customer the pay-link instead.' },
      { status: 409 },
    );
  }

  // plan.method === 'auto_charge' — charge the saved card for the exact balance.
  const result = await chargeBalanceOnFile({
    vaultToken: quote.valor_vault_token,
    amountUsd: invoice.balance,
    orderRef: `bal_${invoice.quote_id}`,
    customerName: quote.customer_name,
    customerEmail: quote.customer_email,
  });

  if (!result.ok) {
    // No state change — the invoice stays awaiting_payment for a retry or the
    // pay-link. Map the seam reason to a status the UI can act on.
    const status = result.reason === 'not-enabled' ? 503 : result.reason === 'no-card' ? 409 : 402;
    return NextResponse.json(
      { ok: false, reason: result.reason, error: result.message ?? 'The card charge did not go through' },
      { status },
    );
  }

  // Charged. Settle the invoice atomically (mirrors the Valor balance webhook):
  // markInvoicePaidManually claims .neq('status','paid') so a retry can't double-settle.
  let paid;
  try {
    paid = await markInvoicePaidManually(id);
  } catch (err) {
    console.error('[api/invoices/:id/charge-balance] settle after charge failed:', err);
    // The charge SUCCEEDED but we couldn't flip the invoice — surface loudly so
    // staff reconcile in Valor (do NOT report a clean success).
    return NextResponse.json(
      { ok: false, reason: 'settle-failed', error: 'Card charged but the invoice could not be updated — reconcile in Valor', txnId: result.txnId },
      { status: 500 },
    );
  }

  // Record the Valor txn/receipt on the invoice (best-effort — the money is in).
  try {
    await sb
      .from('invoices')
      .update({ valor_balance_txn_id: result.txnId, valor_receipt_url: result.receiptUrl })
      .eq('id', id);
  } catch (err) {
    console.warn('[api/invoices/:id/charge-balance] txn record failed:', err);
  }

  // Close the linked job (requires_invoicing → done), best-effort.
  try {
    if (paid?.job_id) {
      const job = await getJob(paid.job_id);
      if (job && job.status === 'requires_invoicing') {
        await setJobStatus(job.id, 'done');
      }
    }
  } catch (err) {
    console.warn('[api/invoices/:id/charge-balance] job close failed:', err);
  }

  return NextResponse.json({
    ok: true,
    charged: true,
    invoice: paid
      ? { id: paid.id, status: paid.status, balance: paid.balance }
      : { id, status: 'paid', balance: 0 },
  });
}
