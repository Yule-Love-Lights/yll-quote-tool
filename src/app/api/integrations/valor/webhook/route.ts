// Inbound webhook: Valor confirms a deposit payment (#38, #42, #43 paid-branch).
//
// POST /api/integrations/valor/webhook
// Headers:
//   Valor-Signature  — HMAC-SHA256 of the body, keyed by VALOR_WEBHOOK_SECRET
//   Valor-Timestamp  — unix seconds (replay window)
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

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  parseWebhookEvent,
  verifyWebhookSignature,
} from '@/lib/integrations/valor';
import {
  sendSms,
  sendEmail,
  updateOpportunityStage,
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
};

export async function POST(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  // Read the RAW body — the signature is computed over the exact bytes, so we
  // must verify before any JSON re-serialization.
  const rawBody = await req.text();

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
  if (!ok) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const rl = rateLimitResponse(req, { bucket: 'valor-webhook', limit: 120, windowMs: 60_000 });
  if (rl) return rl;

  const event = parseWebhookEvent(rawBody);

  if (!event.orderRef) {
    return NextResponse.json(
      { error: 'Webhook missing order reference', code: 'no-order-ref' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_phone, customer_email, total, result, highlevel_contact_id, highlevel_opportunity_id, deposit_paid_at, deposit_amount_usd, approval_snapshot',
    )
    .eq('valor_order_ref', event.orderRef)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    // 404 lets Valor retry in case of a read-after-write race on order-ref.
    return NextResponse.json(
      { error: `No quote for order ref: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
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
  const paidAt = new Date().toISOString();
  const { error: stampErr } = await sb
    .from('quotes')
    .update({
      deposit_paid_at: paidAt,
      valor_txn_id: event.txnId,
      valor_vault_token: event.vaultToken,
      valor_approval_code: event.approvalCode,
      valor_receipt_url: event.receiptUrl,
      valor_payment_raw: event.raw,
    })
    .eq('id', quote.id);

  if (stampErr) {
    console.error('[api/integrations/valor/webhook] paid stamp failed:', stampErr);
    return NextResponse.json(
      { error: `Failed to record payment: ${stampErr.message}` },
      { status: 500 },
    );
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

  // 1. HighLevel: move the opportunity card → ⏰Approved. Falls back to the
  //    SIGNED stage var (same stage id per the ledger) if the dedicated
  //    APPROVED var isn't set.
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
      await updateOpportunityStage(quote.highlevel_opportunity_id, approvedStage);
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
