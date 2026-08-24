// Customer pays the remaining balance via Valor's HOSTED page (ledger #83 — the
// SPEC §4.3 pay-link fallback to the gated auto-charge).
//
// POST /api/quotes/[id]/pay-balance   (PUBLIC — gated by the quote UUID, like /pay)
// Response: { ok: true, redirectUrl, amountUsd, orderRef } | { error, code? }
//
// Reuses the SAME proven hosted-page sale the 50% deposit uses (createHostedPageSale)
// — NO new Valor capability (distinct from the gated card-on-file auto-charge). The
// order ref is `bal_<quoteId>` so the Valor webhook can tell a BALANCE payment from
// a deposit and mark the INVOICE paid (not re-book). A test quote never reaches
// Valor (it has no real balance to collect).
//
// #199: an NCE-tagged quote's balance is never collectable here either (it
// settles through the NCE trade system) — 409 {code:'nce'}, checked both at
// fetch time and in the #187c pre-Valor re-check (same TOCTOU posture as
// view_only). This is the ONE deliberate NCE-facing message on the customer
// portal; the client (portal/[quoteId]/pay-balance/page.tsx) branches on
// this code to show nceBalanceBlockedError() instead of the generic copy.
//
// Row 378: a stale invoice (an amendment whose invoice re-sync lost its CAS
// race) is REFUSED here rather than charged — 409 {code:'invoice-stale'}, the
// customer-side mirror of charge-balance's staff-side guard. The client
// branches on this code to show invoiceStaleError(); staff get a Telegram ping
// so the refusal is not a dead end, and a durable `paymentBlocked` marker lands
// on the quote's approval_snapshot so the block survives a dormant bot. See the
// guard itself, below the re-check.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { createHostedPageSale, isValorConfigured, ValorError } from '@/lib/integrations/valor';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';
import { resolveAgreedTotal, type AgreedTotalSnapshot } from '@/lib/agreedTotal';
import { computeInvoiceResyncTotals, priorBalanceCollectedUsd } from '@/lib/quoteAmendInvoiceSync';
import type { InvoicePricingInput } from '@/lib/invoices';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  is_test: boolean;
  // View-only portal (#176): a staff-flagged browse-only quote can never pay
  // a real balance either — see the check right after the fetch below.
  view_only: boolean;
  // NCE (#199): an NCE trade job's balance settles through NCE, not Valor —
  // see the check right after the fetch below.
  is_nce: boolean;
  // Row 378: the pricing basis the reconciliation guard below recomputes the
  // expected balance from — the SAME three inputs charge-balance's guard uses.
  result: InvoicePricingInput & { total: number } | null;
  approval_snapshot: AgreedTotalSnapshot;
  deposit_amount_usd: number | null;
};

// How long a blocked-payment alert stays "already reported" for. A refused
// customer can re-click, bookmark the link and come back tomorrow, or simply
// reload — each of those re-runs the guard, and without this every one of them
// would page the office again about the SAME order. A channel that gets spammed
// gets muted, which silently recreates the dead end the alert exists to prevent
// (staff-lens MED). One ping per order per hour is enough to be noticed and few
// enough to stay trustworthy.
const PAYMENT_BLOCKED_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Row 378 fix round (staff + admin lenses CONVERGED on this): record a blocked
 * payment DURABLY on the quote, and report whether the office was already told
 * about this order recently.
 *
 * Before this, a refused payment existed only as a `console.error` nobody reads
 * and a Telegram ping that silently no-ops when the bot is dormant, unconfigured,
 * or the audience routes to zero chats — so a customer could be unable to pay us
 * and NOTHING in the product would know. Two independent review lenses reached
 * that finding from different questions, which is what makes it a class rather
 * than a nit.
 *
 * Deliberately mirrors flagInvoiceResyncFailed (quoteAmendInvoiceSync.ts) rather
 * than inventing a second idiom: same approval_snapshot home, same read-then-CAS
 * on the serialized prior value, same DROP-on-lost-race. approval_snapshot holds
 * money data (customerSelection, amendments, invoice_basis) and this write is
 * reachable from a PUBLIC customer route, so it must never blind-overwrite a
 * concurrent amend: a missing forensic marker is survivable, a clobbered snapshot
 * is not. A quote whose snapshot is NULL never gets a marker (the CAS cannot
 * match null against '{}') — the same accepted limitation the sibling carries,
 * and unreachable in practice, since an invoiced quote was approved.
 *
 * Never throws: the customer's 409 must be returned whatever happens here.
 */
async function recordPaymentBlocked(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  quoteId: string,
  invoiceId: string,
  storedBalance: number,
  expectedBalance: number,
): Promise<{ alertedRecently: boolean }> {
  try {
    const { data: quoteRow } = await sb
      .from('quotes')
      .select('approval_snapshot')
      .eq('id', quoteId)
      .maybeSingle<{ approval_snapshot: Record<string, unknown> | null }>();
    const priorSnapshot = quoteRow?.approval_snapshot ?? {};
    // Fix-round-2 (adversarial delta-verify, HIGH — a bug the FIRST fix round
    // introduced): these are TWO different facts and collapsing them into one
    // `at` field created a cooldown that never expired. The first cut compared
    // against `at` and then rewrote `at` to now on EVERY call, including the
    // calls it was suppressing — so a customer re-clicking or reloading inside
    // the hour rolled the window forward each time and staff were NEVER paged
    // again, silently recreating the exact dead end the marker exists to
    // prevent. `at` = when the block was last seen (always refreshed, it is the
    // forensic record). `lastAlertedAt` = when the office was last actually
    // told (only refreshed when a ping really goes out, so the window is
    // anchored to the ping and genuinely expires).
    const priorBlocked = (priorSnapshot as {
      paymentBlocked?: { at?: string; lastAlertedAt?: string };
    }).paymentBlocked;
    const priorAlertAt = priorBlocked?.lastAlertedAt ? Date.parse(priorBlocked.lastAlertedAt) : NaN;
    const alertedRecently =
      Number.isFinite(priorAlertAt) && Date.now() - priorAlertAt < PAYMENT_BLOCKED_ALERT_COOLDOWN_MS;

    const nowIso = new Date().toISOString();
    const nextSnapshot = {
      ...priorSnapshot,
      paymentBlocked: {
        invoiceId,
        storedBalance,
        expectedBalance,
        at: nowIso,
        // Carried forward untouched while suppressing; advanced only when this
        // call is the one that pings.
        lastAlertedAt: alertedRecently ? priorBlocked?.lastAlertedAt : nowIso,
      },
    };
    const { data: updated, error } = await sb
      .from('quotes')
      .update({ approval_snapshot: nextSnapshot })
      .eq('id', quoteId)
      // Serialize jsonb explicitly — PostgREST string-interpolates filter values,
      // so passing the object would compare against "[object Object]" and never
      // match (same reasoning as every sibling CAS in this repo).
      .eq('approval_snapshot', JSON.stringify(priorSnapshot))
      .select('id');
    if (error) {
      console.error('[api/quotes/:id/pay-balance] failed to record the blocked payment on the quote:', error);
    } else if (!updated || updated.length === 0) {
      console.warn(
        `[api/quotes/:id/pay-balance] paymentBlocked marker lost a concurrent write to quote ${quoteId}'s approval_snapshot — dropped (best-effort, not retried)`,
      );
    }
    return { alertedRecently };
  } catch (err) {
    console.error('[api/quotes/:id/pay-balance] failed to record the blocked payment on the quote:', err);
    return { alertedRecently: false };
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-pay-balance', limit: 10, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  if (!isValorConfigured()) {
    return NextResponse.json(
      { error: 'Payment processing is not configured yet', code: 'valor-not-configured' },
      { status: 503 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, customer_name, customer_email, is_test, view_only, is_nce, result, approval_snapshot, deposit_amount_usd')
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // View-only portal (#176): a staff-flagged browse-only quote must never
  // reach real Valor — server hard-guard, checked before any invoice/balance
  // lookup or Valor call. The portal UI's matching gate is StickyBottomBar's
  // viewOnly branch (the DepositCheckout/pay-balance UI is never mounted).
  if (quote.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
    );
  }

  // NCE (#199): the balance settles through the NCE trade system, never
  // Valor — same fast-path posture as view_only above (checked before any
  // invoice/balance lookup or Valor call).
  if (quote.is_nce) {
    return NextResponse.json(
      { error: 'This balance is handled through your NCE trade account — nothing is due here.', code: 'nce' },
      { status: 409 },
    );
  }

  // A test quote never touches real Valor (it has no real balance to collect).
  if (quote.is_test) {
    return NextResponse.json({ error: 'Test quote — no real balance to collect', code: 'test-quote' }, { status: 400 });
  }

  // The balance lives on the invoice (created when the job is completed).
  const job = await getJobByQuote(id);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  if (!invoice) {
    return NextResponse.json({ error: 'No invoice for this order yet', code: 'no-invoice' }, { status: 409 });
  }
  if (invoice.status === 'cancelled') {
    return NextResponse.json({ error: 'This invoice was cancelled', code: 'cancelled' }, { status: 400 });
  }
  if (invoice.status === 'paid' || invoice.balance <= 0) {
    return NextResponse.json({ error: 'No balance due', code: 'no-balance' }, { status: 409 });
  }

  // `bal_<quoteId>` — round-tripped to the webhook as the invoicenumber so it can
  // route a BALANCE payment to the invoice (vs a deposit, which books a quote).
  const orderRef = `bal_${id}`;
  const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
  // `?balance=paid` tells the approved page the customer just paid off the
  // remaining balance (not the deposit) so it confirms the payment instead of
  // repeating the "collected after install" copy.
  const successUrl = `${baseUrl}/portal/${id}/approved?balance=paid`;
  const failureUrl = `${baseUrl}/portal/${id}/pay-balance`;

  // #187c (belt-and-suspenders): the view_only check above is a fast-path
  // gate at fetch time, but the job/invoice lookups above are two more async
  // hops during which staff could flip the flag ON. Re-check immediately
  // before handing off to Valor so a real hosted-page charge is never opened
  // on a quote that's now view-only. This window is near-unreachable today (a
  // booked quote already refuses the toggle), so this is cheap insurance, not
  // a load-bearing guard. #199 rides the same re-check (is_nce is just as
  // staff-toggleable mid-request as view_only).
  //
  // #187 review FIX 3 (#660): fail CLOSED, not open, when the row is gone.
  // `recheck?.view_only` is equally falsy whether the row still exists with
  // view_only=false OR the row no longer exists at all — a bare `?.` read
  // can't tell those apart, so a deleted quote fell through to Valor instead
  // of 404ing (mirrors the fetch-time miss above).
  const { data: recheck } = await sb
    .from('quotes')
    .select('view_only, is_nce')
    .eq('id', id)
    .maybeSingle<{ view_only: boolean; is_nce: boolean }>();
  if (!recheck) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }
  if (recheck.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
    );
  }
  if (recheck.is_nce) {
    return NextResponse.json(
      { error: 'This balance is handled through your NCE trade account — nothing is due here.', code: 'nce' },
      { status: 409 },
    );
  }

  // Row 378 (S48 wrap customer lens): RECONCILIATION guard — the customer half
  // of the pair whose STAFF half shipped in S48 (row 341, PR #927, at
  // charge-balance/route.ts's `invoice-stale` check). Until now this route
  // handed `invoice.balance` straight to Valor with no cross-check, so after an
  // /amend or /amend-decline whose invoice re-sync LOST its CAS race (twice —
  // resyncInvoiceToAgreedTotal retries once, then gives up, leaving the row
  // wrong indefinitely with nothing to self-heal it), a staff charge was
  // refused while the customer clicking their own pay-link was charged the
  // stale figure with no warning. Same defect, opposite sign of the same coin.
  //
  // Re-read the invoice FIRST so the row we validate is the row we charge. The
  // read at the top of this request is now stale — real time has passed through
  // the job/invoice lookups and the view_only/NCE re-check above — and
  // validating row A while charging row B would be a guard in name only. This
  // also closes, for the customer path, the #173 upward-re-sync window that
  // charge-balance's own post-claim re-read closes for staff.
  const freshInvoice = job ? await getInvoiceByJob(job.id) : null;
  if (!freshInvoice) {
    // Fail CLOSED (#187 review FIX 3's posture): a vanished/unreadable invoice
    // must never fall through to the stale figure read at the top.
    console.error(`[api/quotes/:id/pay-balance] invoice for quote ${id} vanished on the pre-Valor re-read`);
    return NextResponse.json({ error: 'No invoice for this order yet', code: 'no-invoice' }, { status: 409 });
  }
  if (freshInvoice.status === 'cancelled') {
    return NextResponse.json({ error: 'This invoice was cancelled', code: 'cancelled' }, { status: 400 });
  }
  if (freshInvoice.status === 'paid' || freshInvoice.balance <= 0) {
    return NextResponse.json({ error: 'No balance due', code: 'no-balance' }, { status: 409 });
  }

  // Recomputes the SAME expected balance a successful re-sync would have
  // written, through the SAME single formula charge-balance uses
  // (computeInvoiceResyncTotals, fed by resolveAgreedTotal and
  // priorBalanceCollectedUsd) — one formula, never a second re-derivation that
  // could drift. Skipped when the quote has no `result`: there is nothing to
  // recompute against, and that is the permissive default every other
  // quote-gated check in this route already takes on missing data.
  //
  // NO override here, deliberately. charge-balance's guard is SOFT because an
  // operator can eyeball the figure and knowingly proceed (`overrideStale`); a
  // customer has no way to verify anything, so on this route the refusal is
  // hard. The release valve is a human reconciling the invoice, which is
  // exactly what the copy and the staff alert below drive.
  if (quote.result) {
    const agreedTotal = resolveAgreedTotal(quote.approval_snapshot, quote.result);
    const expected = computeInvoiceResyncTotals(
      quote.result,
      quote.deposit_amount_usd ?? 0,
      agreedTotal,
      freshInvoice.tax_overridden,
      priorBalanceCollectedUsd(freshInvoice),
    );
    if (Math.abs(expected.balance - freshInvoice.balance) > 0.01) {
      console.error(
        `[api/quotes/:id/pay-balance] REFUSED stale invoice for quote ${id}: ` +
          `invoice.balance=${freshInvoice.balance} expected=${expected.balance} agreedTotal=${agreedTotal}`,
      );
      // Durable first, alert second — the marker is the part that survives a
      // dormant bot, and it doubles as the dedupe key for the ping below.
      const { alertedRecently } = await recordPaymentBlocked(
        sb,
        id,
        freshInvoice.id,
        freshInvoice.balance,
        expected.balance,
      );
      // Best-effort staff alert so a refused customer payment is not a silent
      // dead end — nobody else is watching this path, and the customer has just
      // been told to text us. notifyTelegramAudience never throws and no-ops
      // when the bot is dormant/unconfigured, so this cannot break the response.
      //
      // Money is formatted to cents inline rather than through quoteMessages.ts's
      // usdExact: that helper is module-private inside src/lib/integrations/**, a
      // SHARED-ownership path, and exporting it would need a cross-owner heads-up
      // for what is a purely cosmetic fix here.
      //
      // The remedy line names the path that ACTUALLY works today. A review traced
      // every route and screen for a "reconcile the invoice" action and found none
      // exists — resyncInvoiceToAgreedTotal is called only by /amend and
      // /amend-decline — so telling staff to "reconcile the invoice" (which the
      // staff-side sibling's copy still does, alongside naming an "edit the invoice
      // directly" capability that does not exist anywhere) points at nothing.
      // Recording a $0-change amendment re-runs the invoice sync and is the real
      // fix until a dedicated action exists (ledger row 388).
      if (!alertedRecently) {
        await notifyTelegramAudience(
          'jobs',
          `Balance payment BLOCKED — invoice out of sync
` +
            `${quote.customer_name ?? 'A customer'}${quote.customer_email ? ` (${quote.customer_email})` : ''} ` +
            `tried to pay $${freshInvoice.balance.toFixed(2)}, but this order's current agreed total makes it ` +
            `$${expected.balance.toFixed(2)}.
` +
            `A prior amendment's invoice sync did not land. To fix: open the order below, then Record amendment ` +
            `with a $0 change — that re-runs the invoice sync. Then tell them it's ready to pay.
` +
            `${baseUrl}/admin/invoices/${freshInvoice.id}`,
        );
      }
      return NextResponse.json(
        {
          error: 'We need to confirm the final amount on this order before taking payment.',
          code: 'invoice-stale',
        },
        { status: 409 },
      );
    }
  }

  try {
    const { url } = await createHostedPageSale({
      amountUsd: freshInvoice.balance,
      orderRef,
      successUrl,
      failureUrl,
      customerEmail: quote.customer_email,
      customerName: quote.customer_name,
      orderDescription: 'Yule Love Lights balance',
    });
    return NextResponse.json({ ok: true, redirectUrl: url, amountUsd: freshInvoice.balance, orderRef });
  } catch (err) {
    const msg = err instanceof ValorError ? err.message : err instanceof Error ? err.message : 'Unknown Valor error';
    console.error('[api/quotes/:id/pay-balance] createHostedPageSale failed:', msg);
    return NextResponse.json(
      { error: 'Could not start payment. Please try again.', code: 'hosted-page-failed' },
      { status: 502 },
    );
  }
}
