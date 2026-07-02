// Inbound webhook: Valor confirms a deposit payment (#38, #42, #43 paid-branch).
//
// POST /api/integrations/valor/webhook
// Headers:
//   Valor-Signature  — HMAC-SHA256 of the body, keyed by VALOR_WEBHOOK_SECRET
//   Valor-Timestamp  — UTC timestamp (replay window)
// Body (JSON): { txn_id, response_code, amount, approval_code, receipt_url,
//                <vault/card token>, <our order ref> }   (see parseWebhookEvent)
// Response:
//   { ok: true, booked, alreadyPaid? }   |   { error, code? }
//
// This webhook — NOT the Approve click — is the source of truth for "booked."
// On a verified, approved ("00") payment we:
//   1. Verify the HMAC signature (mandatory — an unverified handler is an
//      "anyone can mark any quote paid" hole).
//   2. Map to the quote via the order ref we round-tripped at checkout time.
//   3. Idempotently stamp deposit_paid_at + the Valor txn / vault / receipt fields
//      (Valor retries up to 3× — dedupe so side effects fire at most once).
//   4. Move the HighLevel opportunity to ⏰Approved.
//   5. Email + text the customer their receipt, and email staff "deposit received."
// Steps 4–5 are best-effort: the payment is already recorded even if they fail.
//
// Verification probe: Valor's Settings → WebHook "Verify and Update" button (and
// generic health checks) hit this URL without a real transaction payload. We
// answer those 200 OK so the URL verifies — see the "liveness probe" branch and
// the GET handler below. They do NO processing; real payment handling stays
// gated behind a valid signature.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  parseWebhookEvent,
  verifyWebhookSignature,
  isValorConfigured,
  type ValorWebhookEvent,
} from '@/lib/integrations/valor';
import {
  sendSms,
  sendEmail,
  updateOpportunity,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import {
  RECEIPT_EMAIL_SUBJECT,
  receiptSmsBody,
  receiptEmailHtml,
  internalPaidEmailSubject,
  internalPaidEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isValorCheckoutEnabled, isValorCheckoutFlagPresent } from '@/lib/integrations/valorCheckout';
import { createJobFromQuote, getJobByQuote, setJobStatus, type JobRow } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';
import { triggerAutoPOIfBusy } from '@/lib/inventory/purchaseOrder';
import { getJobWorkOrder } from '@/lib/inventory/jobs';
import { notifyTelegram } from '@/lib/integrations/telegramNotify';
import { prepJobMessage } from '@/lib/integrations/telegramMessages';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  total: number | null;
  result: QuoteResult | null;
  highlevel_contact_id: string | null;
  highlevel_opportunity_id: string | null;
  deposit_paid_at: string | null;
  deposit_amount_usd: number | null;
  approval_snapshot: {
    customerSelection?: { currentTotalUsd?: number; currentDepositUsd?: number };
  } | null;
  // Test Quote (ledger #93): a test quote must NEVER fire a real side effect.
  // In practice one can't reach here (a test quote has no valor_order_ref — /pay
  // refuses it), but we guard defensively, symmetric with /pay + /simulate-deposit.
  is_test: boolean;
};

// GET — a reachability/liveness check (some webhook verifiers probe with GET).
// Carries no payload + does nothing, so it's safe to always answer 200.
export async function GET() {
  // Lightweight diagnostic (no secrets): surfaces what the SERVER sees so we can
  // confirm config took effect by just opening this URL in a browser.
  //  • checkoutEnabled — is the customer deposit checkout flag ON as read here?
  //  • checkoutFlagPresent — is the flag env var set at all in this deployment
  //    (distinguishes "wrong Vercel env scope / not set" from "set but value odd")
  //  • secretConfigured / isDemo — webhook secret present? charging staging vs prod?
  return NextResponse.json({
    ok: true,
    service: 'valor-webhook',
    checkoutEnabled: isValorCheckoutEnabled(),
    checkoutFlagPresent: isValorCheckoutFlagPresent(),
    secretConfigured: !!process.env.VALOR_WEBHOOK_SECRET,
    isDemo: process.env.VALOR_IS_DEMO !== 'false',
    // Valor API creds the /pay step needs to mint a checkout token (presence
    // only, never values). valorApiConfigured must be true for the card form
    // to load; the per-key flags pinpoint which one is missing.
    valorApiConfigured: isValorConfigured(),
    valorEnv: {
      appId: !!process.env.VALOR_APP_ID,
      appKey: !!process.env.VALOR_APP_KEY,
      epi: !!process.env.VALOR_EPI,
    },
  });
}

export async function POST(req: NextRequest) {
  // Read the RAW body — the signature is computed over the exact bytes, so we
  // must verify before any JSON re-serialization.
  const rawBody = await req.text();

  const rl = rateLimitResponse(req, { bucket: 'valor-webhook', limit: 120, windowMs: 60_000 });
  if (rl) return rl;

  const event = parseWebhookEvent(rawBody);

  // ── Liveness / URL-verification probe ─────────────────────────────────────
  // Valor's "Verify and Update" button (and health checks) hit this URL with no
  // real transaction body. A request that carries NO transaction data (no txn id
  // AND no response code) is therefore a probe — acknowledge 200 so the URL
  // verifies, WITHOUT any processing. Real AUTHCAPTURE/APPROVED events always
  // carry a response_code + txn id, so this can never swallow an actual payment.
  const looksLikeTransaction = !!(event.txnId || event.responseCode);
  if (!looksLikeTransaction) {
    // Log the top-level KEY NAMES (never values — no card-data leak) so that a
    // REAL transaction whose field names differ from our parser (a CONFIRM:
    // seam) is visible here instead of being silently treated as a probe.
    let topKeys: string[] = [];
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object') topKeys = Object.keys(parsed).slice(0, 40);
    } catch {
      /* non-JSON probe */
    }
    console.log(
      `[valor/webhook] probe/no-transaction-fields (200 ack); top-level keys: [${topKeys.join(', ')}]`,
    );
    return NextResponse.json({ ok: true, verification: true });
  }

  // From here it's a real transaction event → require full config + a valid
  // signature before we touch anything.
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const secret = process.env.VALOR_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[api/integrations/valor/webhook] VALOR_WEBHOOK_SECRET not set');
    return NextResponse.json(
      { error: 'VALOR_WEBHOOK_SECRET not configured on server', code: 'secret-missing' },
      { status: 503 },
    );
  }

  const ok = verifyWebhookSignature({
    rawBody,
    signature: req.headers.get('valor-signature'),
    timestamp: req.headers.get('valor-timestamp'),
    secret,
  });
  // Observability for the live CONFIRM: test + ongoing support/reconciliation.
  // Safe to log: transaction METADATA only (no card data, never the secret).
  // `sigOk` is the headline — it confirms our HMAC base/secret match Valor's.
  console.log(
    `[valor/webhook] signed txn: ${JSON.stringify({
      sigOk: ok,
      responseCode: event.responseCode,
      approved: event.approved,
      hasTxnId: !!event.txnId,
      hasOrderRef: !!event.orderRef,
    })}`,
  );
  if (!ok) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Valor sends a webhook for EVERY transaction on this EPI — including normal
  // terminal / Virtual-Terminal sales that did NOT originate from our checkout
  // (those carry no order ref, or one we don't recognize). A transaction we
  // can't tie to a quote is not ours to act on: the signature already verified,
  // so acknowledge 200 and IGNORE it rather than 404-ing (which would make Valor
  // pointlessly retry every unrelated sale). A signed-but-unmatched APPROVED txn
  // is logged loudly in case it ever signals a real booking we failed to map.
  if (!event.orderRef) {
    return NextResponse.json({ ok: true, ignored: 'no-order-ref' });
  }

  // Balance payment branch (ledger #83 pay-link): a `bal_<quoteId>` ref is the
  // remaining 50% balance, NOT a deposit — mark the linked INVOICE paid + close the
  // job, and do NOT run the deposit/booking path. (HMAC already verified above.)
  const balanceMatch = event.orderRef.match(
    /^bal_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (balanceMatch) {
    return handleBalancePayment(balanceMatch[1]!, event);
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_phone, customer_email, total, result, highlevel_contact_id, highlevel_opportunity_id, deposit_paid_at, deposit_amount_usd, approval_snapshot, is_test',
    )
    .eq('valor_order_ref', event.orderRef)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    if (event.approved) {
      console.warn(
        `[api/integrations/valor/webhook] APPROVED txn with unmatched order ref "${event.orderRef}" — no quote found (${fetchErr?.message ?? 'no row'})`,
      );
    }
    return NextResponse.json({ ok: true, ignored: 'no-matching-quote' });
  }

  // Test Quote (#93): a test quote must never trigger a real booking/charge/CRM
  // side effect. It can't normally reach here (it has no valor_order_ref to match
  // on — /pay refuses test quotes), but guard defensively and acknowledge so
  // Valor stops retrying. Test quotes book via /simulate-deposit only.
  if (quote.is_test) {
    console.warn(`[api/integrations/valor/webhook] ignoring webhook for TEST quote ${quote.id}`);
    return NextResponse.json({ ok: true, ignored: 'test-quote' });
  }

  // Idempotency — already recorded as paid. Don't re-fire side effects.
  if (quote.deposit_paid_at) {
    return NextResponse.json({ ok: true, booked: true, alreadyPaid: true });
  }

  // A declined / non-approved transaction: acknowledge so Valor stops retrying,
  // but do NOT mark the quote booked.
  if (!event.approved) {
    console.warn(
      `[api/integrations/valor/webhook] non-approved txn for quote ${quote.id}: response_code=${event.responseCode}`,
    );
    return NextResponse.json({ ok: true, booked: false, declined: true });
  }

  // Record the payment FIRST — before any messaging — so a confirmed deposit is
  // never lost to a downstream hiccup (same pattern as /approve and /signed).
  //
  // ATOMIC CLAIM: the update is conditional on `deposit_paid_at IS NULL`, so when
  // Valor fires concurrent retries (it retries up to 3×) exactly ONE request
  // flips the row and proceeds to the side effects — the others update 0 rows and
  // bail as "already paid". Without this, two retries could both pass the
  // null-check above before either writes and double-fire the receipt + CRM move.
  // Record the ACTUAL charged deposit (not the /pay-stamped INTENDED amount) so
  // the invoice credits what was really collected and the balance stays truthful.
  // A partial authorization (Valor approves '00' for less than asked) would else
  // book at the full intended deposit and silently UNDER-BILL the balance. Keep
  // the intended value when Valor carried no amount (don't null it); log a
  // shortfall for staff but STILL book — a partial deposit is real money (unlike
  // the balance path, which must refuse a short settle).
  const intendedDeposit = quote.deposit_amount_usd;
  const recordedDeposit =
    typeof event.amountUsd === 'number' && Number.isFinite(event.amountUsd)
      ? event.amountUsd
      : intendedDeposit;
  if (
    typeof event.amountUsd === 'number' &&
    typeof intendedDeposit === 'number' &&
    event.amountUsd + 0.01 < intendedDeposit
  ) {
    console.warn(
      `[api/integrations/valor/webhook] deposit shortfall for quote ${quote.id}: charged=${event.amountUsd} intended=${intendedDeposit}`,
    );
  }

  const paidAt = new Date().toISOString();
  const { data: claimed, error: stampErr } = await sb
    .from('quotes')
    .update({
      deposit_paid_at: paidAt,
      // Record what was actually charged (see above) so a partial auth can't
      // silently under-bill the later invoice balance.
      deposit_amount_usd: recordedDeposit,
      // Explicit lifecycle status (ledger #83): deposit paid = booked. This
      // webhook is the source of truth for "booked", so it sets the status too.
      status: 'booked',
      valor_txn_id: event.txnId,
      valor_vault_token: event.vaultToken,
      valor_approval_code: event.approvalCode,
      valor_receipt_url: event.receiptUrl,
      valor_payment_raw: event.raw,
    })
    .eq('id', quote.id)
    .is('deposit_paid_at', null)
    .select('id');

  if (stampErr) {
    console.error('[api/integrations/valor/webhook] paid stamp failed:', stampErr);
    return NextResponse.json(
      { error: `Failed to record payment: ${stampErr.message}` },
      { status: 500 },
    );
  }

  // Lost the race to a concurrent retry — it already recorded the payment and
  // (will) fire the side effects. Acknowledge without double-firing.
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ ok: true, booked: true, alreadyPaid: true });
  }

  // ── Auto-create the Job (ledger #83 Phase 2) ──────────────────────────────
  // Deposit paid = booked = a Job exists. We won the atomic claim, so this is
  // the single booking event; createJobFromQuote is itself idempotent (no-op if
  // a job already exists for the quote — the SHARED-table guard shared with #82).
  // BEST-EFFORT: a failure here must NOT break the webhook or the booking — the
  // payment is already recorded. A missing job can be reconciled later.
  let job: JobRow | null = null;
  try {
    job = await createJobFromQuote(quote.id);
  } catch (err) {
    console.error('[api/integrations/valor/webhook] job auto-create failed:', err);
  }

  // #82 follow-up — proactive prep ping to the inventory Telegram group with the
  // job's full projected materials list (the same work-order projection staff get
  // by email). Best-effort + dormancy-aware (notifyTelegram no-ops unless the bot
  // is enabled): a ping failure must never break the webhook or the booking.
  try {
    if (job) {
      const wo = await getJobWorkOrder(job.id);
      if (wo) {
        await notifyTelegram(
          prepJobMessage({
            customerName: wo.job.customerName,
            jobNumber: wo.job.jobNumber,
            materials: wo.materials.materials,
            unbound: wo.materials.unbound,
            baseUrl: (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, ''),
          }),
        );
      }
    }
  } catch (err) {
    console.error('[api/integrations/valor/webhook] prep ping failed:', err);
  }

  // #82 Phase 3 — event-driven auto-PO. Naldo's rule: the scheduled cron sends
  // every 3 days; this also fires whenever a deposit-paid event leaves us with
  // ≥5 active jobs queued for materials ("more than 4 installs"). Honors all the
  // same gates as the cron (PO_AUTO_SEND_ENABLED + supplier config + dedup).
  // Fully best-effort — the booking is already recorded and a PO send failure
  // must not block the webhook response.
  try {
    const r = await triggerAutoPOIfBusy({ minJobCount: 5 });
    if (r.ok && r.fired) {
      console.info(`[api/integrations/valor/webhook] auto-PO fired (${r.items} SKUs across ${r.jobCount} jobs)`);
    }
  } catch (err) {
    console.error('[api/integrations/valor/webhook] auto-PO trigger failed:', err);
  }

  // ── Best-effort side effects (payment is already recorded) ────────────────
  const depositUsd =
    event.amountUsd ??
    quote.deposit_amount_usd ??
    quote.approval_snapshot?.customerSelection?.currentDepositUsd ??
    quote.result?.depositAmount ??
    0;
  const totalUsd =
    quote.approval_snapshot?.customerSelection?.currentTotalUsd ??
    quote.result?.total ??
    quote.total ??
    depositUsd * 2;

  // 1. HighLevel: move the opportunity card → ⏰Approved AND reset its value to
  //    what the customer ACTUALLY approved (#107 — the card carried the "Full
  //    Yule" ceiling pre-approval; `totalUsd` above is the approved-selection
  //    total from the snapshot). Falls back to the SIGNED stage var (same stage
  //    id per the ledger) if the dedicated APPROVED var isn't set.
  let stageUpdated = false;
  let stageError: string | undefined;
  const approvedStage =
    process.env.HIGHLEVEL_STAGE_QUOTE_APPROVED || process.env.HIGHLEVEL_STAGE_QUOTE_SIGNED;
  if (!quote.highlevel_opportunity_id) {
    stageError = 'No HighLevel opportunity linked to this quote';
  } else if (!isHighLevelConfigured()) {
    stageError = 'HighLevel not configured';
  } else if (!approvedStage) {
    stageError = 'HIGHLEVEL_STAGE_QUOTE_APPROVED env var not set';
  } else {
    try {
      await updateOpportunity(quote.highlevel_opportunity_id, {
        pipelineStageId: approvedStage,
        // Guard 0/missing so a degenerate total never BLANKS a live card:
        // updateOpportunity omits `undefined` but would push a literal `0`.
        // Mirrors the attach route's `> 0` guard.
        monetaryValue: totalUsd > 0 ? totalUsd : undefined,
      });
      stageUpdated = true;
    } catch (err) {
      console.warn('[api/integrations/valor/webhook] HL stage move failed:', hlErrorMessage(err));
      stageError = hlErrorMessage(err);
    }
  }

  // 2. Customer receipt + 3. internal "deposit received" alert, via GHL.
  let customerSmsSent = false;
  let customerEmailSent = false;
  let internalEmailSent = false;
  if (isHighLevelConfigured()) {
    const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const confirmationUrl = `${baseUrl}/portal/${quote.id}/approved`;
    const adminUrl = `${baseUrl}/quote/${quote.id}`;
    const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';

    if (quote.highlevel_contact_id) {
      try {
        await sendSms({
          contactId: quote.highlevel_contact_id,
          message: receiptSmsBody(firstName, depositUsd, phone),
          fromNumber,
        });
        customerSmsSent = true;
      } catch (err) {
        console.warn('[api/integrations/valor/webhook] receipt SMS failed:', hlErrorMessage(err));
      }
      try {
        await sendEmail({
          contactId: quote.highlevel_contact_id,
          subject: RECEIPT_EMAIL_SUBJECT,
          html: receiptEmailHtml({
            firstName,
            depositUsd,
            totalUsd,
            receiptUrl: event.receiptUrl,
            confirmationUrl,
            phone,
          }),
          emailFrom,
        });
        customerEmailSent = true;
      } catch (err) {
        console.warn('[api/integrations/valor/webhook] receipt email failed:', hlErrorMessage(err));
      }
    }

    const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    if (internalContactId) {
      try {
        await sendEmail({
          contactId: internalContactId,
          subject: internalPaidEmailSubject(quote.customer_name),
          html: internalPaidEmailHtml({
            customerName: quote.customer_name,
            depositUsd,
            totalUsd,
            txnId: event.txnId,
            approvalCode: event.approvalCode,
            receiptUrl: event.receiptUrl,
            adminUrl,
          }),
          emailFrom,
        });
        internalEmailSent = true;
      } catch (err) {
        console.warn('[api/integrations/valor/webhook] internal email failed:', hlErrorMessage(err));
      }
    }
  }

  return NextResponse.json({
    ok: true,
    booked: true,
    paidAt,
    stageUpdated,
    stageError,
    customerSmsSent,
    customerEmailSent,
    internalEmailSent,
  });
}

// Handle a #83 balance pay-link payment (orderRef `bal_<quoteId>`): mark the linked
// invoice paid + close the job. HMAC + config already verified by the caller.
// Test-safe: a test quote's balance is never collected via real Valor — ignore one
// defensively. Idempotent: an atomic claim flips the invoice paid at most once.
async function handleBalancePayment(quoteId: string, event: ValorWebhookEvent): Promise<NextResponse> {
  if (!event.approved) {
    console.warn(
      `[api/integrations/valor/webhook] non-approved balance txn for quote ${quoteId}: response_code=${event.responseCode}`,
    );
    return NextResponse.json({ ok: true, balance: true, declined: true });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote } = await sb
    .from('quotes')
    .select('id, is_test')
    .eq('id', quoteId)
    .maybeSingle<{ id: string; is_test: boolean }>();
  if (!quote) return NextResponse.json({ ok: true, ignored: 'balance-no-quote' });
  if (quote.is_test) {
    console.warn(`[api/integrations/valor/webhook] ignoring balance webhook for TEST quote ${quoteId}`);
    return NextResponse.json({ ok: true, ignored: 'test-quote' });
  }

  const job = await getJobByQuote(quoteId);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  if (!invoice) return NextResponse.json({ ok: true, ignored: 'balance-no-invoice' });
  if (invoice.status === 'paid') {
    return NextResponse.json({ ok: true, balance: true, alreadyPaid: true });
  }
  // B6 fix: a cancelled invoice must NEVER be resurrected by a late/retried webhook.
  // Valor retries up to 3×: the booking may have been cancelled between the pay-link
  // send and this webhook arriving. Ack 200 so Valor stops retrying; do NOT settle.
  if (invoice.status === 'cancelled') {
    console.warn(
      `[api/integrations/valor/webhook] ignoring balance webhook for CANCELLED invoice ${invoice.id} (quote ${quoteId})`,
    );
    return NextResponse.json({ ok: true, ignored: 'invoice-cancelled' });
  }

  // Verify the paid amount actually covers the balance (review CRITICAL). The
  // webhook is the source of truth — any approved bal_-tagged txn on this EPI
  // reaches here — so do NOT settle a full balance on a short / partial / unrelated
  // payment. 1-cent tolerance for float rounding; a shortfall is logged + ignored
  // (the invoice stays unpaid for staff to reconcile).
  const paid = event.amountUsd;
  if (paid == null || paid + 0.01 < invoice.balance) {
    console.error(
      `[api/integrations/valor/webhook] balance underpayment for quote ${quoteId}: paid=${paid} expected>=${invoice.balance}`,
    );
    return NextResponse.json({ ok: true, balance: true, underpaid: true });
  }

  // Atomic claim — only the first webhook flips an unpaid invoice to paid (Valor
  // retries up to 3×), so the job-close fires at most once. B6 hardening (TOCTOU):
  // claim ONLY when the status is still a settle-able state (draft/awaiting_payment)
  // rather than `.neq('status','paid')`. This closes the residual race where the
  // invoice flips to `cancelled` between the fast-path guard read above and this
  // write — a cancelled invoice no longer matches the claim, so it can never be
  // settled here (the .neq form would have let cancelled through).
  const paidAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await sb
    .from('invoices')
    .update({
      status: 'paid',
      balance: 0,
      paid_at: paidAt,
      valor_balance_txn_id: event.txnId,
      valor_receipt_url: event.receiptUrl,
    })
    .eq('id', invoice.id)
    .in('status', ['draft', 'awaiting_payment'])
    .select('id');
  if (claimErr) {
    console.error('[api/integrations/valor/webhook] balance settle write failed:', claimErr);
    return NextResponse.json({ error: 'Failed to record the balance payment' }, { status: 500 });
  }
  if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
    return NextResponse.json({ ok: true, balance: true, alreadyPaid: true });
  }

  // Close the job once the balance is collected (best-effort — payment is recorded).
  if (job && job.status === 'requires_invoicing') {
    try {
      await setJobStatus(job.id, 'done');
    } catch (err) {
      console.error('[api/integrations/valor/webhook] balance: job close failed:', err);
    }
  }
  return NextResponse.json({ ok: true, balance: true, paid: true, paidAt });
}
