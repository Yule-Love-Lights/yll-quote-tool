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
// #173 STALE-BALANCE race: the `invoice` read at the top of the request can go
// stale before the charge — an amend can re-sync invoices.balance UPWARD while
// this request sits behind the gate checks / quote fetch / reconsent check /
// claim write. Once the idempotency claim lands (below), the route re-reads
// the invoice ONCE more and charges that FRESH balance instead — charging the
// stale (lower) one would settle the invoice at $0 against a higher true
// balance (silent under-collection). The post-charge settle CAS also pins
// `balance = <the amount actually charged>`, so an amend landing DURING the
// Valor round-trip (after the fresh read, before settle) can't silently
// settle either — it falls into a new 'stale-balance' diagnosis branch
// alongside the existing double-charge/charged-cancelled ones: money already
// moved, the invoice is NOT settled, and the difference is surfaced loudly
// (response + staff alert email) for the operator to collect + reconcile.
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
// #199: an NCE-tagged quote's balance settles through the NCE trade system,
// never a card charge — blocked ahead of the cash-preference check (fires
// regardless of payment_preference). Body `{ overrideNce: true }` is the
// release valve, mirroring overridePreference exactly; the two can combine
// (an NCE + cash_check invoice needs both flags to charge the card anyway).
//
// Response: { ok, charged, invoice } | { ok:false, reason, error }
//   reason additionally includes (this idempotency pre-claim):
//     'charge-in-flight' — a charge is already being attempted (409); retry later.
//     'already-charged'  — a real txn id is already on file (409); reconcile in Valor.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoice, appendRetiredTxn } from '@/lib/invoices';
import { getJob, setJobStatus } from '@/lib/jobs';
import { sendEmail, isHighLevelConfigured } from '@/lib/integrations/highlevel';
import {
  duplicatePaymentEmailSubject,
  duplicatePaymentEmailHtml,
  staleBalanceEmailSubject,
  staleBalanceEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { planBalanceCollection } from '@/lib/balanceCollection';
import { chargeBalanceOnFile, isAutoChargeEnabled, CHARGE_SLOT_STALE_MS } from '@/lib/integrations/valorBalance';
import { latestConsentAmendment, blocksSettlement, amendedQuoteStatus, reconsentRequiredClause, type AmendmentTrailEntry } from '@/lib/amend';
import type { QuoteStatus } from '@/lib/quoteStatus';
// #173: same EPSILON-nudged + finite-guarded round-to-cents invoices.ts/amend.ts/
// balanceCollection.ts already alias as round2 — used to keep the stale-balance
// diagnosis's "difference still owed" free of floating-point noise.
import { roundMoneyGuarded as round2 } from '@/lib/money';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Charge idempotency pre-claim (see the header's ⚠️ IDEMPOTENCY note) ────
const PENDING_PREFIX = 'pending:';
// Single source with the UI's describeChargeSlot (#640 review LOW — the two
// constants must never drift or the "frees itself after 15 minutes" banner lies).
const PENDING_STALE_MS = CHARGE_SLOT_STALE_MS;

// #170(c): hard ceiling on a single card-on-file charge. Biggest real YLL jobs
// run low five figures; anything above this is a data bug, not a balance.
const MAX_AUTO_CHARGE_USD = 25_000;

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
  is_nce: boolean;
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

  let body: { overrideReconsent?: unknown; overridePreference?: unknown; overrideNce?: unknown } = {};
  try {
    body = (await req.json()) as { overrideReconsent?: unknown; overridePreference?: unknown; overrideNce?: unknown };
  } catch {
    body = {};
  }
  const override =
    body.overrideReconsent === true || req.nextUrl.searchParams.get('override') === 'true';
  const overridePreference = body.overridePreference === true;
  // #199: mirrors overridePreference exactly (request-scoped, never persisted).
  const overrideNce = body.overrideNce === true;

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

  // The saved card + customer live on the quote (+ the WT-18 amendment trail
  // + #199's is_nce). Moved ahead of the cash-preference/over-cap checks
  // below so the NCE block (right after) can fire BEFORE them — an NCE
  // quote's balance is never a card charge, full stop, regardless of
  // payment_preference or the amount.
  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: qErr } = await sb
    .from('quotes')
    .select('valor_vault_token, customer_name, customer_email, approval_snapshot, status, is_nce')
    .eq('id', invoice.quote_id)
    .single<QuoteCardRow>();
  if (qErr || !quote) {
    return NextResponse.json({ ok: false, reason: 'no-quote', error: 'Linked quote not found' }, { status: 409 });
  }

  // #199: an NCE trade job's balance settles through NCE, never a card
  // charge. Checked BEFORE the cash-preference gate below — an NCE quote is
  // blocked regardless of its payment_preference.
  if (quote.is_nce && !overrideNce) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'nce-blocked',
        error:
          'This is an NCE trade job — the balance settles through NCE, not a card charge. Record it with "Mark paid — NCE", or pass the explicit override to charge the card anyway.',
      },
      { status: 409 },
    );
  }

  // #170(d): the customer said they'd settle in cash/check — never one-click
  // charge their card. The UI mirrors this (button replaced by an explicit
  // "charge anyway" override); the server enforces it so no other caller can skip it.
  if (invoice.payment_preference === 'cash_check' && !overridePreference) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'cash-preference',
        error: 'This customer pays by cash/check — record the payment with Mark paid, or pass the explicit override to charge the card anyway.',
      },
      { status: 409 },
    );
  }

  // #170(c): absolute ceiling. No YLL balance legitimately approaches this; a
  // corrupted balance (bad amend math, a bad import) must not reach the card.
  if (invoice.balance > MAX_AUTO_CHARGE_USD) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'over-cap',
        error: `Balance $${invoice.balance} exceeds the $${MAX_AUTO_CHARGE_USD} auto-charge ceiling — collect via pay-link or reconcile the invoice.`,
      },
      { status: 409 },
    );
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
          // FIX7 (review MED): distinguish "no answer yet" from "customer
          // said no" — an operator about to override deserves to know which.
          error: `${reconsentRequiredClause(latest)} Pass an operator override to charge anyway.`,
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

  // CAS-exact release of OUR claim, mirrored from the chargeBalanceOnFile
  // failure-path release below — pulled into a helper because #173 needs the
  // same idiom at an additional call site (the fresh-read guard right below).
  const releaseClaim = async (why: string): Promise<void> => {
    try {
      const { data: released, error: releaseErr } = await sb
        .from('invoices')
        .update({ valor_balance_txn_id: null })
        .eq('id', id)
        .eq('valor_balance_txn_id', pendingSentinel)
        .select('id');
      if (releaseErr) {
        console.warn(`[api/invoices/:id/charge-balance] pending-claim release failed (${why}):`, releaseErr);
      } else if (!released || released.length === 0) {
        console.warn(
          `[api/invoices/:id/charge-balance] pending-claim release skipped for invoice ${id} (${why}) — sentinel was already overwritten`,
        );
      }
    } catch (err) {
      console.warn(`[api/invoices/:id/charge-balance] pending-claim release failed (${why}):`, err);
    }
  };

  // #173 (ledger — the stale-balance under-charge race): the `invoice` read at
  // the top of this request is now stale — real time has passed through the
  // gate checks, the quote fetch, the reconsent check, and the claim write
  // above, and an amend can re-sync invoices.balance UPWARD in that window
  // (amend's invoice re-sync never touches valor_balance_txn_id unless it's
  // reopening a PAID invoice, so the claim above always still belongs to us).
  // Charging the STALE (lower) balance would settle the invoice to $0 against
  // a balance that's actually higher — silent under-collection. Re-read ONCE
  // now that we hold the claim and charge the FRESH balance instead. Only the
  // checks a balance change can invalidate are re-run here (no-balance, the
  // #170(c) ceiling) — cancelled/payment_preference/reconsent/plan.method were
  // already validated above against fields a balance change doesn't touch.
  const freshInvoice = await getInvoice(id);
  if (!freshInvoice) {
    console.error(`[api/invoices/:id/charge-balance] invoice ${id} vanished on the post-claim re-read`);
    await releaseClaim('invoice missing on re-read');
    return NextResponse.json(
      { ok: false, reason: 'error', error: 'Invoice not found on re-read — try again' },
      { status: 500 },
    );
  }
  if (freshInvoice.status === 'paid' || freshInvoice.balance <= 0) {
    // The balance cleared (or the invoice was already paid) while we were
    // validating — nothing left to charge. Release the claim so it doesn't
    // wedge the slot for 15 minutes over a charge that will never happen.
    await releaseClaim('balance cleared before charge');
    return NextResponse.json({ ok: false, reason: 'no-balance', error: 'No balance due' }, { status: 409 });
  }
  if (freshInvoice.balance > MAX_AUTO_CHARGE_USD) {
    await releaseClaim('balance now exceeds ceiling');
    return NextResponse.json(
      {
        ok: false,
        reason: 'over-cap',
        error: `Balance $${freshInvoice.balance} exceeds the $${MAX_AUTO_CHARGE_USD} auto-charge ceiling — collect via pay-link or reconcile the invoice.`,
      },
      { status: 409 },
    );
  }
  // The amount actually requested from Valor — the #170(c) capture-equality
  // guard and the settle CAS below both compare against this SAME fresh
  // number, never the stale `invoice.balance` read at request start.
  const chargeAmount = freshInvoice.balance;

  const result = await chargeBalanceOnFile({
    vaultToken: quote.valor_vault_token,
    amountUsd: chargeAmount,
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
      // sentinel so this can never clobber a concurrent real txn id. A 0-row
      // release is CORRECT (something real overwrote the sentinel) but logged
      // for symmetry with the success-path record write (#640 review LOW).
      try {
        const { data: released, error: releaseErr } = await sb
          .from('invoices')
          .update({ valor_balance_txn_id: null })
          .eq('id', id)
          .eq('valor_balance_txn_id', pendingSentinel)
          .select('id');
        if (releaseErr) {
          console.warn('[api/invoices/:id/charge-balance] pending-claim release failed:', releaseErr);
        } else if (!released || released.length === 0) {
          console.warn(
            `[api/invoices/:id/charge-balance] pending-claim release skipped for invoice ${id} — sentinel was already overwritten`,
          );
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

  // #170(c) capture-amount guard (tightens the old ≥ check): the captured amount
  // must EQUAL the requested balance to the cent. Short = a partial auth (the old
  // case: settling would silently under-bill). Over = an amount-parse bug (the
  // #165 cents-vs-dollars class — a 100× misparse sails through a ≥ check). Either
  // way the invoice must NOT settle; leave it awaiting_payment + a loud log.
  // #173: compares against `chargeAmount` (the FRESH balance we actually
  // requested), not the stale `invoice.balance` — they're the same number
  // unless a mid-request amend moved the balance, which is exactly the case
  // piece 1's re-read exists to charge correctly.
  if (result.chargedUsd == null || Math.abs(result.chargedUsd - chargeAmount) > 0.01) {
    console.error(
      `[api/invoices/:id/charge-balance] capture/balance mismatch for invoice ${id}: charged=${result.chargedUsd} expected=${chargeAmount} txn=${result.txnId}`,
    );
    return NextResponse.json(
      {
        ok: false,
        reason: 'amount-mismatch',
        error: `Card captured $${result.chargedUsd ?? '?'} but the balance is $${chargeAmount} — the invoice was NOT settled. Reconcile in Valor.`,
        txnId: result.txnId,
      },
      { status: 402 },
    );
  }

  // Charged the full balance. Settle via an ATOMIC CLAIM on a settle-able status
  // (#170(a) — mirrors the webhook's B6 form, replacing markInvoicePaidManually):
  // 0 rows updated means someone ELSE settled while our Valor charge was in
  // flight — and the only other settler is the customer's pay-link webhook, so
  // the card was charged TWICE. The old code treated that as a friendly
  // idempotent no-op and then overwrote the webhook's txn id; now it's a loud
  // double-charge branch instead.
  const paidAt = new Date().toISOString();
  let settledRows: { id: string; job_id: string | null }[] | null = null;
  try {
    const { data, error } = await sb
      .from('invoices')
      .update({ status: 'paid', balance: 0, paid_at: paidAt })
      .eq('id', id)
      .in('status', ['draft', 'awaiting_payment'])
      // #173: also require the balance to still equal what we actually
      // charged. A mid-charge amend (the narrow window between piece 1's
      // fresh re-read and this settle, i.e. during the Valor round-trip) can
      // re-sync the balance UPWARD without touching status — this predicate
      // makes that race claim 0 rows too, instead of silently settling the
      // invoice to $0 against a balance that's actually higher.
      .eq('balance', chargeAmount)
      .select('id, job_id');
    if (error) throw error;
    settledRows = data;
  } catch (err) {
    console.error('[api/invoices/:id/charge-balance] settle after charge failed:', err);
    // The charge SUCCEEDED but we couldn't flip the invoice — surface loudly so
    // staff reconcile in Valor (do NOT report a clean success). The pending
    // sentinel is deliberately left; the 15-min valve frees it.
    return NextResponse.json(
      { ok: false, reason: 'settle-failed', error: 'Card charged but the invoice could not be updated — reconcile in Valor', txnId: result.txnId },
      { status: 500 },
    );
  }

  if (!settledRows || settledRows.length === 0) {
    // #170(a)/#173: the settle claimed 0 rows — the invoice moved while our
    // charge was in flight. Re-read ONCE and diagnose (#640 review HIGH: a
    // job-cancel racing the charge is NOT a double charge — a single real
    // charge landed on a now-cancelled invoice and needs a REFUND, not a
    // void-the-duplicate hunt). #173 added a THIRD cause: the settle CAS now
    // also requires `balance = chargeAmount`, so a mid-charge amend re-syncing
    // the balance while our Valor call was in flight claims 0 rows too — even
    // though status is still perfectly settle-able.
    const fresh = await getInvoice(id);
    const cancelledRace = fresh?.status === 'cancelled';
    // amend's invoice re-sync never sets status to 'paid' or 'cancelled' (only
    // the money fields move, or a PAID invoice reopens to awaiting_payment —
    // never the reverse; and if an amend-down drove balance to ≤0 it would
    // have set status 'paid' directly, which falls out of this branch into
    // the double-charge one below — a pre-existing ambiguity this fix doesn't
    // touch). So when status is STILL draft/awaiting_payment after a 0-row
    // settle, status can't be why the CAS missed — the balance predicate is
    // the only thing left that could have failed, and fresh.balance is
    // therefore guaranteed > 0 here.
    const staleBalanceRace =
      !cancelledRace && (fresh?.status === 'draft' || fresh?.status === 'awaiting_payment');
    // The settled txn on file (the webhook's) — for the double-charge alert
    // email. Never a sentinel: the webhook overwrote ours when IT settled; on
    // the cancel race and the stale-balance race nothing overwrites our claim,
    // so the slot may still hold OUR sentinel, which is not a txn — mask it.
    const settledTxnOnFile =
      fresh?.valor_balance_txn_id && !isPendingSentinel(fresh.valor_balance_txn_id)
        ? fresh.valor_balance_txn_id
        : null;
    // #173 HIGH-1 (money-review): the balance can move DOWN too — an amend
    // DROPPING the true balance mid-charge is just as real as one raising it.
    // A naive `max(0, fresh.balance - chargeAmount)` silently zeroed a genuine
    // OVER-collection and told staff "$0 still owed" when a REFUND was
    // actually due. Sign-aware instead: 'under' (balance grew — we owe more),
    // 'over' (balance shrank below what we charged — refund the excess), or
    // 'even' (the narrow window where the balance moved a SECOND time between
    // the failed settle and this diagnosis read and landed back on
    // chargeAmount — no net difference, but the CAS still couldn't settle it
    // automatically). staleBalanceRace true ⇒ fresh is non-null ⇒ diff is
    // non-null — the `!` uses below reflect that correlation.
    const diff = staleBalanceRace && fresh ? round2(fresh.balance - chargeAmount) : null;
    const staleBalanceDirection: 'under' | 'over' | 'even' | null =
      diff == null ? null : diff > 0.005 ? 'under' : diff < -0.005 ? 'over' : 'even';
    const absDiff = diff == null ? null : Math.abs(diff);
    console.error(
      cancelledRace
        ? `[api/invoices/:id/charge-balance] charge landed on a CANCELLED invoice ${id} — REFUND txn ${result.txnId} in Valor`
        : staleBalanceRace
          ? `[api/invoices/:id/charge-balance] STALE-BALANCE (${staleBalanceDirection}) for invoice ${id}: charged ${chargeAmount}, balance now ${fresh?.balance ?? '?'} (diff ${diff ?? '?'}) — txn ${result.txnId} NOT settled`
          : `[api/invoices/:id/charge-balance] DOUBLE CHARGE for invoice ${id}: pay-link settled during our charge — VOID our txn ${result.txnId} in Valor`,
    );
    // Stash our txn in the retirement log — CAS'd append (#640 review MED: a
    // plain read-modify-write could lose a concurrent amend rotation). Unlike
    // the double-charge/cancelled cases the stale-balance txn is a REAL, valid
    // charge (not a duplicate or an orphan) — it still goes through the same
    // log so the txn id is never lost to reconciliation.
    await appendRetiredTxn(id, {
      txnId: result.txnId ?? 'unknown',
      receiptUrl: result.receiptUrl ?? null,
      settledAt: null,
      retiredAt: paidAt,
      reason: cancelledRace
        ? 'charged-while-cancelled — REFUND in Valor'
        : staleBalanceRace
          ? staleBalanceDirection === 'over'
            ? `stale-balance-over-collection — charged $${chargeAmount}, balance dropped to $${fresh?.balance ?? '?'} — REFUND $${absDiff ?? '?'} in Valor`
            : staleBalanceDirection === 'even'
              ? `stale-balance-mismatch — charged $${chargeAmount}, balance now $${fresh?.balance ?? '?'} (no net difference) — reconcile in Valor`
              : `stale-balance-under-collection — charged $${chargeAmount}, balance now $${fresh?.balance ?? '?'}, $${absDiff ?? '?'} still owed — reconcile in Valor`
          : 'double-charge-operator-leg — VOID in Valor',
    });
    // #173 HIGH-2 (money-review): replace the pending sentinel with the REAL
    // txn id — CAS on our exact sentinel, mirroring the success-path record
    // write below. One card charge landed on this invoice; leaving the
    // sentinel would let it go stale after 15 minutes and a LATER click would
    // reclaim + auto-charge AGAIN (the balance math has no idea this charge
    // already happened — amend's total−deposit_applied re-sync doesn't know
    // about charge-balance captures). Writing the real txn id makes any later
    // click hit the route's existing 'already-charged' 409 instead. Verified
    // (grepped amend/route.ts + amend.ts): amend's invoice re-sync NEVER
    // clears/rotates valor_balance_txn_id for a non-paid invoice — only a
    // reopen-a-PAID-invoice amend does — so this is a PERMANENT block on this
    // button for this invoice, by design: one card charge already landed;
    // further collection/refund goes through amend + pay-link/mark-paid, or a
    // manual Valor refund, never a second blind auto-charge. The
    // appendRetiredTxn entry above stays as the annotated audit trail
    // (intentional redundancy: the log records WHY, this column is now the
    // PRIMARY idempotency record).
    if (staleBalanceRace) {
      try {
        const { data: recorded, error: recordErr } = await sb
          .from('invoices')
          .update({ valor_balance_txn_id: result.txnId, valor_receipt_url: result.receiptUrl })
          .eq('id', id)
          .eq('valor_balance_txn_id', pendingSentinel)
          .select('id');
        if (recordErr) {
          console.warn('[api/invoices/:id/charge-balance] stale-balance txn record failed:', recordErr);
        } else if (!recorded || recorded.length === 0) {
          console.error(
            `[api/invoices/:id/charge-balance] stale-balance txn record skipped for invoice ${id} — sentinel was already overwritten (txn ${result.txnId}); reconcile in Valor`,
          );
        }
      } catch (err) {
        console.warn('[api/invoices/:id/charge-balance] stale-balance txn record failed:', err);
      }
    }
    try {
      const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
      if (isHighLevelConfigured() && internalContactId) {
        await sendEmail({
          contactId: internalContactId,
          subject: staleBalanceRace
            ? staleBalanceEmailSubject(quote.customer_name, staleBalanceDirection!)
            : duplicatePaymentEmailSubject(quote.customer_name),
          html: staleBalanceRace
            ? staleBalanceEmailHtml({
                customerName: quote.customer_name,
                chargedUsd: chargeAmount,
                newBalanceUsd: fresh?.balance ?? null,
                direction: staleBalanceDirection!,
                txnId: result.txnId ?? 'unknown',
                adminUrl: `${(process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '')}/admin/invoices/${id}`,
              })
            : duplicatePaymentEmailHtml({
                customerName: quote.customer_name,
                amountUsd: invoice.balance,
                newTxnId: result.txnId ?? 'unknown',
                existingTxnId: settledTxnOnFile,
                adminUrl: `${(process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '')}/admin/invoices/${id}`,
              }),
          emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
        });
      }
    } catch (err) {
      console.error('[api/invoices/:id/charge-balance] settle-conflict alert email failed:', err);
    }
    return NextResponse.json(
      cancelledRace
        ? {
            ok: false,
            reason: 'charged-cancelled',
            error: `This invoice was CANCELLED while the charge was in flight — the card WAS charged. REFUND transaction ${result.txnId ?? '(no id — find by amount/time)'} in Valor now.`,
            txnId: result.txnId,
          }
        : staleBalanceRace
          ? {
              ok: false,
              reason: 'stale-balance',
              error:
                staleBalanceDirection === 'over'
                  ? `Card captured $${chargeAmount} but the balance dropped to $${fresh?.balance ?? '?'} while the charge was in flight — that's a $${absDiff ?? '?'} OVER-collection. The invoice was NOT settled. REFUND $${absDiff ?? '?'} in Valor now; once reconciled, mark the invoice paid (the net payment covers the current balance). Reference transaction ${result.txnId ?? '(no id — find by amount/time)'}.`
                  : staleBalanceDirection === 'even'
                    ? `Card captured $${chargeAmount} and the balance is now $${fresh?.balance ?? '?'} (no net difference), but the invoice could not be settled automatically — the balance changed more than once during the charge. Verify the invoice balance and reconcile transaction ${result.txnId ?? '(no id — find by amount/time)'} in Valor before marking it paid.`
                    : `Card captured $${chargeAmount} but the balance grew to $${fresh?.balance ?? '?'} while the charge was in flight (difference $${absDiff ?? '?'} still owed) — the invoice was NOT settled. Amend the invoice if needed so the balance reflects what's actually owed, then collect the difference via pay-link (or mark paid), and reconcile transaction ${result.txnId ?? '(no id — find by amount/time)'} in Valor.`,
              txnId: result.txnId,
            }
          : {
              ok: false,
              reason: 'double-charge',
              error: `The customer paid the pay-link while this charge was in flight — the card was charged TWICE. VOID transaction ${result.txnId ?? '(no id — find by amount/time)'} in Valor now.`,
              txnId: result.txnId,
            },
      { status: 409 },
    );
  }

  // Record the Valor txn/receipt on the invoice. CAS on our exact pending
  // sentinel (#170(a) — was an unconditional write that could erase a
  // concurrent webhook's txn id): we settled, so the sentinel should still be
  // ours; if something else overwrote it, keep THAT record and just log.
  try {
    const { data: recorded, error: recordErr } = await sb
      .from('invoices')
      .update({ valor_balance_txn_id: result.txnId, valor_receipt_url: result.receiptUrl })
      .eq('id', id)
      .eq('valor_balance_txn_id', pendingSentinel)
      .select('id');
    if (recordErr) {
      console.warn('[api/invoices/:id/charge-balance] txn record failed:', recordErr);
    } else if (!recorded || recorded.length === 0) {
      console.error(
        `[api/invoices/:id/charge-balance] txn record skipped for invoice ${id} — sentinel was overwritten (txn ${result.txnId}); reconcile in Valor`,
      );
    }
  } catch (err) {
    console.warn('[api/invoices/:id/charge-balance] txn record failed:', err);
  }

  // Close the linked job (requires_invoicing → done), best-effort.
  try {
    const jobId = settledRows[0]?.job_id;
    if (jobId) {
      const job = await getJob(jobId);
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
    invoice: { id, status: 'paid', balance: 0 },
  });
}
