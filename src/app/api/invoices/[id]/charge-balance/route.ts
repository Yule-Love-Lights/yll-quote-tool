// POST /api/invoices/[id]/charge-balance  (operator-only)
//
// Operator-triggered "Charge remaining balance" — charge the card saved at
// deposit (quotes.valor_vault_token) for the invoice's EXACT balance, no customer
// present (ledger #83). This is the manual (staff-clicks-when-ready) counterpart
// to the customer pay-link; it is NOT auto-on-complete.
//
// GATED: the real charge lives in chargeBalanceOnFile (src/lib/integrations/
// valorBalance.ts), which is wired to Valor's Tokenized Sale API but still
// behind VALOR_AUTO_CHARGE_ENABLED (returns 'not-enabled' until the flag is
// flipped — see docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md). Until then
// this route never moves money: it validates + returns a non-ok reason, and
// the operator UI hides the button (the flag is echoed by GET /api/invoices/[id]).
//
// ⚠️ IDEMPOTENCY: a double-click / two open tabs could fire two charges before
// either settles. The post-charge SETTLE is atomic (markInvoicePaidManually's
// .neq status,'paid'/'cancelled'), but the Valor CHARGE itself is not — Valor
// has no duplicate_transaction_check wired here — so BEFORE calling
// chargeBalanceOnFile we atomically pre-claim the charge slot by writing a
// `pending:<ISO timestamp>` sentinel into invoices.valor_balance_txn_id via a
// conditional UPDATE (0 rows updated = lost the race). Branches on the current
// value read from getInvoice:
//   - null                        → claim via `.is('valor_balance_txn_id', null)`;
//                                    0 rows → 409 'charge-in-flight'.
//   - 'pending:<fresh, <15m old>' → 409 'charge-in-flight' (another request holds it).
//   - 'pending:<stale, >=15m old>'→ a crashed/never-cleared prior attempt; CAS-reclaim
//                                    via `.eq('valor_balance_txn_id', <exact stale value>)`;
//                                    0 rows (lost a race to reclaim) → 409 'charge-in-flight'.
//   - anything else (a real txn id) → 409 'already-charged' (reconcile in Valor).
// On a non-ok chargeBalanceOnFile result the claim is released back to null via
// a CAS on our exact sentinel (never clobbers a concurrent real txn id) — EXCEPT
// on an ambiguous TIMEOUT, where the sentinel is deliberately LEFT (a charge may
// have landed at Valor; the 15-min stale window is the release valve, and the
// response text says to reconcile). On success, the existing post-settle write
// below overwrites valor_balance_txn_id unconditionally by id (safe — we hold
// the claim), so the sentinel never survives a successful charge.
//
// Amount = the invoice balance ONLY (not an arbitrary operator amount). To change
// the amount, amend the order (which re-prices the balance) — partial/arbitrary
// charges are not modelled on the invoice.
//
// PARTIAL-AUTH guard: a card-on-file sale can capture LESS than requested. The
// route refuses to settle unless result.chargedUsd (the amount Valor ACTUALLY
// captured) covers the balance — so the real wiring MUST populate chargedUsd or
// this route will (safely) never settle. Mirrors the balance webhook's guard.
//
// WT-18: before charging, block a quote whose LATEST amendment is a
// price-increasing change the customer hasn't re-approved yet
// (src/lib/amend.ts blocksSettlement/requiresReconsent) — an amend-up silently
// reopens the invoice to awaiting_payment with zero proof of re-consent, and
// this route would otherwise happily auto-charge the card on file for it. An
// operator override (body `{ overrideReconsent: true }` or `?override=true`)
// is the release valve for this wave; a real customer-facing re-approval flow
// is separate, later work.
//
// Response: { ok, charged, invoice } | { ok:false, reason, error }
//   reason additionally includes (this idempotency pre-claim):
//     'charge-in-flight' — a charge is already being attempted (409); retry later.
//     'already-charged'  — a real txn id is already on file (409); reconcile in Valor.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoice, markInvoicePaidManually } from '@/lib/invoices';
import { getJob, setJobStatus } from '@/lib/jobs';
import { planBalanceCollection } from '@/lib/balanceCollection';
import { chargeBalanceOnFile, isAutoChargeEnabled } from '@/lib/integrations/valorBalance';
import { latestConsentAmendment, blocksSettlement, amendedQuoteStatus, type AmendmentTrailEntry } from '@/lib/amend';
import type { QuoteStatus } from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Charge idempotency pre-claim (see the header's ⚠️ IDEMPOTENCY note) ────
const PENDING_PREFIX = 'pending:';
const PENDING_STALE_MS = 15 * 60 * 1000; // 15 min — the release valve for a crashed/never-cleared claim

function isPendingSentinel(v: string): boolean {
  return v.startsWith(PENDING_PREFIX);
}

// Age (ms) of a `pending:<ISO timestamp>` sentinel. null when the embedded
// timestamp doesn't parse — treated as stale (safer to allow a reclaim than to
// wedge the invoice behind an unparseable marker forever).
function pendingAgeMs(v: string): number | null {
  const t = Date.parse(v.slice(PENDING_PREFIX.length));
  return Number.isFinite(t) ? Date.now() - t : null;
}

type QuoteCardRow = {
  valor_vault_token: string | null;
  customer_name: string | null;
  customer_email: string | null;
  approval_snapshot: { amendments?: AmendmentTrailEntry[] } | null;
  status: QuoteStatus | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }

  let body: { overrideReconsent?: unknown } = {};
  try {
    body = (await req.json()) as { overrideReconsent?: unknown };
  } catch {
    body = {};
  }
  const override =
    body.overrideReconsent === true || req.nextUrl.searchParams.get('override') === 'true';

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

  // The saved card + customer live on the quote (+ the WT-18 amendment trail).
  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: qErr } = await sb
    .from('quotes')
    .select('valor_vault_token, customer_name, customer_email, approval_snapshot, status')
    .eq('id', invoice.quote_id)
    .single<QuoteCardRow>();
  if (qErr || !quote) {
    return NextResponse.json({ ok: false, reason: 'no-quote', error: 'Linked quote not found' }, { status: 409 });
  }

  if (!override) {
    const latest = latestConsentAmendment(quote.approval_snapshot?.amendments);
    if (blocksSettlement(latest)) {
      console.warn(
        `[api/invoices/:id/charge-balance] blocked charge for invoice ${id} — reconsent required ` +
          `(quote ${invoice.quote_id} would read '${amendedQuoteStatus(latest!, quote.status ?? 'booked')}')`,
      );
      return NextResponse.json(
        {
          ok: false,
          reason: 'reconsent-required',
          code: 'reconsent-required',
          error:
            'This order has a price increase awaiting customer re-approval. Pass an operator override to charge anyway.',
        },
        { status: 409 },
      );
    }
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

  // ⚠️ IDEMPOTENCY pre-claim (see the header note): atomically claim the charge
  // slot BEFORE calling Valor, so a double-click / two open tabs can't both fire
  // a real charge. invoice.valor_balance_txn_id was already loaded by getInvoice
  // above (INVOICE_SELECT includes it) — no extra read needed.
  const existingTxnId = invoice.valor_balance_txn_id;
  const pendingSentinel = `${PENDING_PREFIX}${new Date().toISOString()}`;
  const chargeInFlight = () =>
    NextResponse.json(
      { ok: false, reason: 'charge-in-flight', error: 'A charge is already in progress' },
      { status: 409 },
    );

  if (existingTxnId == null) {
    // Nothing on file yet — claim only if it's STILL null (CAS against null).
    const { data: claimed, error: claimErr } = await sb
      .from('invoices')
      .update({ valor_balance_txn_id: pendingSentinel })
      .eq('id', id)
      .is('valor_balance_txn_id', null)
      .select('id');
    if (claimErr) {
      console.error('[api/invoices/:id/charge-balance] claim write failed:', claimErr);
      return NextResponse.json(
        { ok: false, reason: 'error', error: 'Failed to claim the charge slot — try again' },
        { status: 500 },
      );
    }
    if (!claimed || claimed.length === 0) return chargeInFlight(); // lost the race
  } else if (isPendingSentinel(existingTxnId)) {
    const ageMs = pendingAgeMs(existingTxnId);
    const isStale = ageMs == null || ageMs > PENDING_STALE_MS;
    if (!isStale) return chargeInFlight(); // another request holds a fresh claim

    // Stale — a crashed/never-cleared prior attempt. Reclaim via a CAS against
    // the EXACT stale value, so a fresh concurrent claim (or the original
    // request finishing late) can't be clobbered.
    const { data: reclaimed, error: reclaimErr } = await sb
      .from('invoices')
      .update({ valor_balance_txn_id: pendingSentinel })
      .eq('id', id)
      .eq('valor_balance_txn_id', existingTxnId)
      .select('id');
    if (reclaimErr) {
      console.error('[api/invoices/:id/charge-balance] stale-claim reclaim failed:', reclaimErr);
      return NextResponse.json(
        { ok: false, reason: 'error', error: 'Failed to claim the charge slot — try again' },
        { status: 500 },
      );
    }
    if (!reclaimed || reclaimed.length === 0) return chargeInFlight(); // lost the reclaim race
  } else {
    // A real Valor txn id is already recorded — this balance was already charged.
    return NextResponse.json(
      { ok: false, reason: 'already-charged', error: 'A balance charge was already recorded — reconcile in Valor' },
      { status: 409 },
    );
  }

  const result = await chargeBalanceOnFile({
    vaultToken: quote.valor_vault_token,
    amountUsd: invoice.balance,
    orderRef: `bal_${invoice.quote_id}`,
    customerName: quote.customer_name,
    customerEmail: quote.customer_email,
  });

  if (!result.ok) {
    // Ambiguous outcome on a TIMEOUT — the charge may have landed at Valor even
    // though we never saw the response. Do NOT release the claim in that case
    // (a released claim would let a retry double-charge); the 15-min stale
    // window is the release valve, and the response text says to reconcile.
    const isAmbiguousTimeout = result.reason === 'error' && result.message?.toLowerCase().includes('timed out');
    if (!isAmbiguousTimeout) {
      // Release the claim so the operator can retry — CAS against our EXACT
      // sentinel so this can never clobber a concurrent real txn id.
      try {
        const { error: releaseErr } = await sb
          .from('invoices')
          .update({ valor_balance_txn_id: null })
          .eq('id', id)
          .eq('valor_balance_txn_id', pendingSentinel);
        if (releaseErr) {
          console.warn('[api/invoices/:id/charge-balance] pending-claim release failed:', releaseErr);
        }
      } catch (err) {
        console.warn('[api/invoices/:id/charge-balance] pending-claim release failed:', err);
      }
    }

    // No state change (balance-wise) — the invoice stays awaiting_payment for a
    // retry or the pay-link. Map the seam reason to a status the UI can act on.
    const status = result.reason === 'not-enabled' ? 503 : result.reason === 'no-card' ? 409 : 402;
    return NextResponse.json(
      {
        ok: false,
        reason: result.reason,
        error: isAmbiguousTimeout
          ? `${result.message} — the charge slot was left pending; reconcile in Valor before retrying.`
          : (result.message ?? 'The card charge did not go through'),
      },
      { status },
    );
  }

  // Short-capture guard (mirrors the balance webhook, webhook/route.ts): a partial
  // authorization captures LESS than the balance. The invoice must NOT settle as
  // paid-in-full, or we'd silently under-bill. Refuse to settle when the captured
  // amount is missing or short; leave the invoice awaiting_payment + a loud log.
  if (result.chargedUsd == null || result.chargedUsd + 0.01 < invoice.balance) {
    console.error(
      `[api/invoices/:id/charge-balance] partial/unknown capture for invoice ${id}: charged=${result.chargedUsd} expected>=${invoice.balance} txn=${result.txnId}`,
    );
    return NextResponse.json(
      {
        ok: false,
        reason: 'partial-capture',
        error: 'Card was approved for less than the balance — the invoice was NOT settled. Reconcile in Valor.',
        txnId: result.txnId,
      },
      { status: 402 },
    );
  }

  // Charged the full balance. Settle the invoice atomically (mirrors the webhook):
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
  // This is also what retires the pending-claim sentinel from above: it writes
  // unconditionally by id (safe — we hold the claim, and nothing else settles
  // this invoice), and writes result.txnId AS-IS — including null, on the rare
  // chance Valor approved without echoing a txn id — so the sentinel can never
  // survive a successful charge (a null write still overwrites 'pending:...').
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
