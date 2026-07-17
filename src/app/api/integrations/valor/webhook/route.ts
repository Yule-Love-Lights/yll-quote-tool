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
import { resolvePipelineStages } from '@/lib/integrations/ghlPipelineMap';
import {
  RECEIPT_EMAIL_SUBJECT,
  receiptSmsBody,
  receiptEmailHtml,
  internalPaidEmailSubject,
  internalPaidEmailHtml,
  duplicatePaymentEmailSubject,
  duplicatePaymentEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isValorCheckoutEnabled, isValorCheckoutFlagPresent } from '@/lib/integrations/valorCheckout';
import { createJobFromQuote, getJobByQuote, setJobStatus, type JobRow } from '@/lib/jobs';
import { getInvoiceByJob, type InvoiceRow } from '@/lib/invoices';
import { triggerAutoPOIfBusy } from '@/lib/inventory/purchaseOrder';
import { getJobWorkOrder } from '@/lib/inventory/jobs';
import { notifyTelegram } from '@/lib/integrations/telegramNotify';
import { prepJobMessage } from '@/lib/integrations/telegramMessages';
import { accrueOnBooking, ensureReferralCode } from '@/lib/referrals';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

// W1-006: a quote already marked paid can still receive a SECOND approved
// webhook carrying a DIFFERENT txn id — the customer paid on two live hosted
// checkout pages for the same order ref. That's a genuine extra charge, not a
// Valor retry (a retry replays the SAME txn id), so it must leave a durable
// record + alert staff instead of a bare silent ack. Same-txn-id replays are
// intentionally NOT flagged here — that's the correct, expected idempotent path.
async function flagPossibleDuplicatePayment(
  sb: ReturnType<typeof getSupabaseServiceClient>,
  quote: Pick<QuoteRow, 'id' | 'customer_name' | 'valor_txn_id' | 'approval_snapshot'>,
  event: ValorWebhookEvent,
  baseUrl: string,
): Promise<void> {
  if (!event.approved || !event.txnId || event.txnId === quote.valor_txn_id) return;

  const amountUsd = typeof event.amountUsd === 'number' && Number.isFinite(event.amountUsd) ? event.amountUsd : 0;
  console.error(
    `[api/integrations/valor/webhook] POSSIBLE DOUBLE CHARGE for quote ${quote.id}: new txn ${event.txnId} differs from txn on file ${quote.valor_txn_id} — refund in Valor`,
  );

  // Merge into approval_snapshot — never clobber customerSelection/amendments/signature.
  try {
    await sb!
      .from('quotes')
      .update({
        approval_snapshot: {
          ...(quote.approval_snapshot ?? {}),
          duplicatePayment: { txnId: event.txnId, at: new Date().toISOString(), amountUsd },
        },
      })
      .eq('id', quote.id);
  } catch (err) {
    console.error('[api/integrations/valor/webhook] duplicate-payment snapshot stamp failed:', err);
  }

  // Best-effort staff alert — must never break the 200 ack Valor is waiting on.
  try {
    const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    if (isHighLevelConfigured() && internalContactId) {
      await sendEmail({
        contactId: internalContactId,
        subject: duplicatePaymentEmailSubject(quote.customer_name),
        html: duplicatePaymentEmailHtml({
          customerName: quote.customer_name,
          amountUsd,
          newTxnId: event.txnId,
          existingTxnId: quote.valor_txn_id,
          adminUrl: `${baseUrl}/quote/${quote.id}`,
        }),
        emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
      });
    }
  } catch (err) {
    console.error('[api/integrations/valor/webhook] duplicate-payment alert email failed:', err);
  }
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
  // Which GHL pipeline this quote's card lives in (resolvePipelineStages).
  service_type: string | null;
  deposit_paid_at: string | null;
  deposit_amount_usd: number | null;
  // The txn id stamped by the ORIGINAL deposit charge — read back so a second
  // approved webhook (a genuinely distinct charge) can be told apart from a
  // Valor retry of the SAME transaction (W1-006).
  valor_txn_id: string | null;
  // Explicit lifecycle status (ledger #83) — used to refuse booking a dead
  // (cancelled / declined / lost) quote even when it still holds a live pay link
  // (W1-007).
  status: import('@/lib/quoteStatus').QuoteStatus | null;
  approval_snapshot: {
    customerSelection?: { currentTotalUsd?: number; currentDepositUsd?: number };
    [key: string]: unknown;
  } | null;
  // Test Quote (ledger #93): a test quote must NEVER fire a real side effect.
  // In practice one can't reach here (a test quote has no valor_order_ref — /pay
  // refuses it), but we guard defensively, symmetric with /pay + /simulate-deposit.
  is_test: boolean;
  // Legacy rebook (#156): routes to the Neighbors pipeline instead of the
  // service_type's own map — see resolvePipelineStages.
  legacy_rebook: boolean;
  // Referral program (#41 PR 2): the quote's OWN linked customer (if any), so
  // this booking can stamp their referral code too (see below).
  customer_id: string | null;
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
    // #159 DIAGNOSTIC (first real payment, 2026-07-17): a REAL hosted-page
    // deposit (quote #1191) charged fine at Valor with our ref stored as its
    // Invoice No (`q…`), but its E-Invoice confirmation webhook carried NO field
    // parseWebhookEvent recognizes as the order ref → hasOrderRef:false → the
    // charge is IGNORED here and the quote never auto-books. We can't fix the
    // pick-list without knowing Valor's actual field name, and the summary log
    // above doesn't reveal it. Log the payload's top-level + one-level-nested
    // KEY NAMES (names only — NEVER values, so no card/PII data leaks; mirrors
    // the probe branch's safe key-name logging) so the NEXT deposit reveals the
    // field, which then gets added to the pick-list (or we stamp Valor's `uid`
    // at /pay and match on it). Behavior is otherwise unchanged — still a 200 ack.
    const keyDump: string[] = [];
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const k of Object.keys(parsed as Record<string, unknown>).slice(0, 60)) {
          keyDump.push(k);
          const v = (parsed as Record<string, unknown>)[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const k2 of Object.keys(v as Record<string, unknown>).slice(0, 60)) keyDump.push(`${k}.${k2}`);
          }
        }
      }
    } catch {
      /* non-JSON body */
    }
    console.log(
      `[valor/webhook] APPROVED txn IGNORED (no recognized order ref) — payload keys: [${keyDump.join(', ')}]`,
    );
    return NextResponse.json({ ok: true, ignored: 'no-order-ref' });
  }

  // Balance payment branch (ledger #83 pay-link): a `bal_<quoteId>` ref is the
  // remaining 50% balance, NOT a deposit — mark the linked INVOICE paid + close the
  // job, and do NOT run the deposit/booking path. (HMAC already verified above.)
  const balanceMatch = event.orderRef.match(
    /^bal_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (balanceMatch) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    return handleBalancePayment(balanceMatch[1]!, event, baseUrl);
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_phone, customer_email, total, result, highlevel_contact_id, highlevel_opportunity_id, service_type, deposit_paid_at, deposit_amount_usd, valor_txn_id, status, approval_snapshot, is_test, legacy_rebook, customer_id',
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
  // W1-006: but first check whether this is a GENUINELY DISTINCT approved charge
  // (a different txn id than the one on file) rather than Valor retrying the same
  // transaction — the former is a real double charge and must be flagged.
  if (quote.deposit_paid_at) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    await flagPossibleDuplicatePayment(sb, quote, event, baseUrl);
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

  // W1-007: refuse to BOOK a dead quote. cancelled→booked is an illegal transition
  // (quoteStatus.ts: cancelled/declined/lost are terminal), yet a cancelled quote
  // could still hold a live pay link and an approved txn would otherwise flip it to
  // 'booked'. Fast-path check (mirrored by the terminal-status guard on the atomic
  // claim below, which closes the read-then-write race). Log LOUDLY — real money
  // moved on Valor's side (an approved '00'), so staff must reconcile/refund; ack
  // 200 so Valor stops retrying. Same gap class as the FIXED balance-path #83-005
  // cancelled-invoice resurrection.
  if (quote.status === 'cancelled' || quote.status === 'declined' || quote.status === 'lost') {
    console.error(
      `[api/integrations/valor/webhook] APPROVED deposit txn for ${quote.status} quote ${quote.id} — NOT booking a dead order; real money may have moved (txn ${event.txnId}), staff must reconcile/refund`,
    );
    return NextResponse.json({ ok: true, booked: false, ignored: `quote-${quote.status}` });
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
    // W1-007: also exclude terminal states in the atomic claim so a cancel/decline
    // landing between the fast-path status check above and this write can't be raced
    // past into 'booked'. Use the OR-with-null idiom (NOT a bare `.not`) so a
    // legacy/NULL-status row still books — Postgres `NOT (NULL IN (…))` is NULL and
    // would silently exclude it (the same three-valued-logic trap fixed in /approve,
    // W1-014). Mirrors the /approve B2 guard + the decline route's null handling.
    .or('status.not.in.("declined","cancelled","lost"),status.is.null')
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
  // W1-006: `quote.valor_txn_id` is the value read BEFORE this claim attempt (the
  // row was unpaid then), so it's still the right basis to detect a genuinely
  // distinct second approved charge racing in under a different txn id.
  if (!claimed || claimed.length === 0) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    await flagPossibleDuplicatePayment(sb, quote, event, baseUrl);
    return NextResponse.json({ ok: true, booked: true, alreadyPaid: true });
  }

  // Referral program (#41): if this quote was referred (link or mention), the
  // booking event is what flips that referral from pending → booked. Best-
  // effort — accrueOnBooking already fails open internally, but this call is
  // wrapped too (belt-and-suspenders, mirrors every other side effect on this
  // path): an accrual hiccup must NEVER break the payment webhook.
  try {
    await accrueOnBooking(quote.id);
  } catch (err) {
    console.error('[api/integrations/valor/webhook] referral accrual failed:', err);
  }

  // Referral program (#41 PR 2): stamp THIS quote's own customer with their
  // referral code (+ GHL link) at the booking event, not only when they later
  // view the booked page — so every customer has their link live in GHL by
  // install day. Fail-open — must never break the payment webhook.
  try {
    if (quote.customer_id) await ensureReferralCode(quote.customer_id);
  } catch (err) {
    console.error('[api/integrations/valor/webhook] referral code stamp failed:', err);
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

  // ── Best-effort post-booking side effects (payment is already recorded) ────
  // W1-027: these external calls (Telegram prep ping, auto-PO trigger, HL stage
  // move, customer receipt SMS + email, internal alert email) are mutually
  // INDEPENDENT — the booking claim + createJobFromQuote already ran above and
  // are the only ordered steps. Running them sequentially added up to seconds of
  // webhook latency (which risks Valor retrying). Fire them concurrently with
  // Promise.allSettled: each still logs its own failure individually and stays
  // non-fatal exactly as before — the payment is recorded regardless.
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
  const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');

  // Result flags mutated by the parallel tasks below (each writes only its own).
  let stageUpdated = false;
  let stageError: string | undefined;
  let customerSmsSent = false;
  let customerEmailSent = false;
  let internalEmailSent = false;

  // #82 follow-up — proactive prep ping to the inventory Telegram group with the
  // job's full projected materials list. Best-effort + dormancy-aware (notifyTelegram
  // no-ops unless the bot is enabled).
  const prepPing = async () => {
    if (!job) return;
    const wo = await getJobWorkOrder(job.id);
    if (wo) {
      await notifyTelegram(
        prepJobMessage({
          customerName: wo.job.customerName,
          jobNumber: wo.job.jobNumber,
          materials: wo.materials.materials,
          unbound: wo.materials.unbound,
          baseUrl,
        }),
      );
    }
  };

  // #82 Phase 3 — event-driven auto-PO. Fires whenever a deposit-paid event leaves
  // us with ≥5 active jobs queued for materials ("more than 4 installs"). Honors
  // all the same gates as the cron (PO_AUTO_SEND_ENABLED + supplier config + dedup).
  const autoPO = async () => {
    const r = await triggerAutoPOIfBusy({ minJobCount: 5 });
    if (r.ok && r.fired) {
      console.info(`[api/integrations/valor/webhook] auto-PO fired (${r.items} SKUs across ${r.jobCount} jobs)`);
    } else if (!r.ok) {
      // #110 W6-003: triggerAutoPOIfBusy resolves {ok:false} on a send failure
      // (never throws), so this was previously silent — the automatic supplier
      // order not going out would leave no trace.
      console.error('[api/integrations/valor/webhook] auto-PO failed:', r.status, r.error);
    }
  };

  // HighLevel: move the opportunity card → ⏰Approved (holiday) / Booked (event) /
  // Closed (permanent) AND reset its value to what the customer ACTUALLY approved
  // (#107). Per-service-type resolution (#GHL pipeline sync) — holiday still
  // honors the legacy HIGHLEVEL_STAGE_QUOTE_APPROVED env var (falling back to
  // SIGNED, same stage id per the ledger) so prod behavior is byte-identical;
  // permanent/event always use their own pipeline's depositPaid stage.
  const hlStageMove = async () => {
    const stages = resolvePipelineStages(quote.service_type, { legacyRebook: quote.legacy_rebook });
    if (!quote.highlevel_opportunity_id) {
      stageError = 'No HighLevel opportunity linked to this quote';
      return;
    }
    if (!isHighLevelConfigured()) {
      stageError = 'HighLevel not configured';
      return;
    }
    try {
      await updateOpportunity(quote.highlevel_opportunity_id, {
        pipelineStageId: stages.depositPaid,
        // Guard 0/missing so a degenerate total never BLANKS a live card.
        monetaryValue: totalUsd > 0 ? totalUsd : undefined,
      });
      stageUpdated = true;
    } catch (err) {
      console.warn('[api/integrations/valor/webhook] HL stage move failed:', hlErrorMessage(err));
      stageError = hlErrorMessage(err);
    }
  };

  // Customer receipt SMS + email and the internal "deposit received" alert, via GHL.
  const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
  const confirmationUrl = `${baseUrl}/portal/${quote.id}/approved`;
  const adminUrl = `${baseUrl}/quote/${quote.id}`;
  const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
  const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
  const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
  const hlReady = isHighLevelConfigured();
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;

  const customerSms = async () => {
    if (!hlReady || !quote.highlevel_contact_id) return;
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
  };

  const customerEmail = async () => {
    if (!hlReady || !quote.highlevel_contact_id) return;
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
  };

  const internalEmail = async () => {
    if (!hlReady || !internalContactId) return;
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
  };

  // Run the independent side effects concurrently. Each already swallows + logs
  // its own error; allSettled is belt-and-suspenders so one unexpected throw can
  // never reject the batch or the webhook.
  const settled = await Promise.allSettled([
    prepPing(),
    autoPO(),
    hlStageMove(),
    customerSms(),
    customerEmail(),
    internalEmail(),
  ]);
  const [prepR, autoPOR] = settled;
  if (prepR.status === 'rejected') {
    console.error('[api/integrations/valor/webhook] prep ping failed:', prepR.reason);
  }
  if (autoPOR.status === 'rejected') {
    console.error('[api/integrations/valor/webhook] auto-PO trigger failed:', autoPOR.reason);
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

type BalanceQuoteRow = {
  id: string;
  customer_name: string | null;
  is_test: boolean;
  approval_snapshot: Record<string, unknown> | null;
};

// WT-14: mirrors flagPossibleDuplicatePayment (deposit path, above) for the #83
// balance pay-link. A second APPROVED balance txn on an invoice that's already
// settled (or that lost the atomic claim below to a concurrent request),
// carrying a DIFFERENT txn id than the one recorded on the invoice, is a
// genuine second charge — not a Valor retry (which replays the SAME txn id).
// Same-txn-id replays are the correct, expected idempotent path and stay silent.
async function flagPossibleDuplicateBalancePayment(
  sb: ReturnType<typeof getSupabaseServiceClient>,
  quote: BalanceQuoteRow,
  invoice: Pick<InvoiceRow, 'valor_balance_txn_id'>,
  event: ValorWebhookEvent,
  baseUrl: string,
): Promise<void> {
  if (!event.approved || !event.txnId || event.txnId === invoice.valor_balance_txn_id) return;

  const amountUsd = typeof event.amountUsd === 'number' && Number.isFinite(event.amountUsd) ? event.amountUsd : 0;
  console.error(
    `[api/integrations/valor/webhook] POSSIBLE DOUBLE CHARGE (balance) for quote ${quote.id}: new txn ${event.txnId} differs from balance txn on file ${invoice.valor_balance_txn_id} — refund in Valor`,
  );

  // Merge into approval_snapshot — same shape as the deposit path's marker,
  // never clobbering customerSelection/amendments/signature.
  try {
    await sb!
      .from('quotes')
      .update({
        approval_snapshot: {
          ...(quote.approval_snapshot ?? {}),
          duplicateBalancePayment: { txnId: event.txnId, at: new Date().toISOString(), amountUsd },
        },
      })
      .eq('id', quote.id);
  } catch (err) {
    console.error('[api/integrations/valor/webhook] duplicate balance-payment snapshot stamp failed:', err);
  }

  // Best-effort staff alert — reuse the SAME double-charge email as the deposit path.
  try {
    const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    if (isHighLevelConfigured() && internalContactId) {
      await sendEmail({
        contactId: internalContactId,
        subject: duplicatePaymentEmailSubject(quote.customer_name),
        html: duplicatePaymentEmailHtml({
          customerName: quote.customer_name,
          amountUsd,
          newTxnId: event.txnId,
          existingTxnId: invoice.valor_balance_txn_id,
          adminUrl: `${baseUrl}/quote/${quote.id}`,
        }),
        emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
      });
    }
  } catch (err) {
    console.error('[api/integrations/valor/webhook] duplicate balance-payment alert email failed:', err);
  }
}

// Local escape — quoteMessages.ts's escapeHtml is unexported, and this route
// doesn't otherwise touch that file. Same minimal escaping it uses.
function escapeAlertHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// WT-15: a partial/short balance payment must surface for staff in-app, not
// only in a server log line. Stamp a durable marker on the quote (same
// approval_snapshot merge pattern as the duplicate-payment flag above) and
// send a best-effort internal staff alert, so the shortfall is visible even
// if nobody is watching the logs.
async function flagBalanceUnderpayment(
  sb: ReturnType<typeof getSupabaseServiceClient>,
  quote: BalanceQuoteRow,
  event: ValorWebhookEvent,
  baseUrl: string,
  paidUsd: number | null,
  expectedUsd: number,
): Promise<void> {
  const paid = typeof paidUsd === 'number' && Number.isFinite(paidUsd) ? paidUsd : 0;
  const shortfallUsd = Math.max(0, expectedUsd - paid);

  try {
    await sb!
      .from('quotes')
      .update({
        approval_snapshot: {
          ...(quote.approval_snapshot ?? {}),
          balanceUnderpayment: {
            txnId: event.txnId,
            paidUsd: paid,
            expectedUsd,
            shortfallUsd,
            at: new Date().toISOString(),
          },
        },
      })
      .eq('id', quote.id);
  } catch (err) {
    console.error('[api/integrations/valor/webhook] balance-underpayment snapshot stamp failed:', err);
  }

  try {
    const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    if (isHighLevelConfigured() && internalContactId) {
      const who = quote.customer_name?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
      const row = (label: string, value: string) =>
        `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
      await sendEmail({
        contactId: internalContactId,
        subject: `⚠️ Balance underpaid: ${who}`,
        html: [
          `<p><strong>${escapeAlertHtml(who)}</strong>'s balance pay-link came back SHORT — the charge did not cover the full amount due.</p>`,
          `<p><strong>Action needed:</strong> collect the remaining $${shortfallUsd.toFixed(2)} manually and settle the invoice in the admin tools.</p>`,
          `<table style="border-collapse:collapse;font-size:14px;">`,
          row('Paid', `$${paid.toFixed(2)}`),
          row('Expected', `$${expectedUsd.toFixed(2)}`),
          row('Shortfall', `$${shortfallUsd.toFixed(2)}`),
          row('Transaction id', escapeAlertHtml(event.txnId || '—')),
          `</table>`,
          `<p><a href="${baseUrl}/quote/${quote.id}">Open in quote tool →</a></p>`,
        ].join('\n'),
        emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
      });
    }
  } catch (err) {
    console.error('[api/integrations/valor/webhook] balance-underpayment alert email failed:', err);
  }
}

// Handle a #83 balance pay-link payment (orderRef `bal_<quoteId>`): mark the linked
// invoice paid + close the job. HMAC + config already verified by the caller.
// Test-safe: a test quote's balance is never collected via real Valor — ignore one
// defensively. Idempotent: an atomic claim flips the invoice paid at most once.
async function handleBalancePayment(
  quoteId: string,
  event: ValorWebhookEvent,
  baseUrl: string,
): Promise<NextResponse> {
  if (!event.approved) {
    console.warn(
      `[api/integrations/valor/webhook] non-approved balance txn for quote ${quoteId}: response_code=${event.responseCode}`,
    );
    return NextResponse.json({ ok: true, balance: true, declined: true });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote } = await sb
    .from('quotes')
    .select('id, customer_name, is_test, approval_snapshot')
    .eq('id', quoteId)
    .maybeSingle<BalanceQuoteRow>();
  if (!quote) return NextResponse.json({ ok: true, ignored: 'balance-no-quote' });
  if (quote.is_test) {
    console.warn(`[api/integrations/valor/webhook] ignoring balance webhook for TEST quote ${quoteId}`);
    return NextResponse.json({ ok: true, ignored: 'test-quote' });
  }

  const job = await getJobByQuote(quoteId);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  if (!invoice) return NextResponse.json({ ok: true, ignored: 'balance-no-invoice' });
  if (invoice.status === 'paid') {
    // WT-14: tell a genuine second charge (a different txn id than the one
    // recorded on the invoice) apart from a Valor retry of the SAME settled
    // transaction before silently acking.
    await flagPossibleDuplicateBalancePayment(sb, quote, invoice, event, baseUrl);
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
    // WT-15: durable marker + staff alert — a partial balance payment must
    // surface in-app, not only in the log line above.
    await flagBalanceUnderpayment(sb, quote, event, baseUrl, paid, invoice.balance);
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
    // WT-14: same duplicate check on the lost-race path (mirrors the deposit
    // path's atomic-claim-lost branch above). `invoice.valor_balance_txn_id`
    // here is the value read BEFORE this claim attempt (the row was unsettled
    // then), so it's still the right basis to detect a genuinely distinct
    // second approved charge racing in under a different txn id.
    await flagPossibleDuplicateBalancePayment(sb, quote, invoice, event, baseUrl);
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
