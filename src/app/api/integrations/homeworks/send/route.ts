// Send a saved quote to home.works via the Zapier Catch Hook. Triggered
// from the admin UI when the operator clicks "Send to home.works for
// signature + payment."
//
// POST /api/integrations/homeworks/send
// Headers:  x-admin-secret: <ADMIN_SECRET>
// Body:
//   { quoteId: string }   — UUID from our quotes table
// Response:
//   { ok: true, sentAt: ISO }   — on success
//   { error: string }           — on failure (HTTP 400/500/502/503)
//
// This endpoint is admin-gated because it triggers downstream actions
// (estimate creation, possibly emailing the customer). We don't want a
// stray test to create a real job in home.works.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  sendQuoteToHomeworks,
  isHomeworksConfigured,
  buildHomeworksSingleLineItem,
  HomeworksError,
} from '@/lib/integrations/homeworks';
import type { HomeworksPayload } from '@/lib/integrations/types';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { safeEqual } from '@/lib/security';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Quote row shape we pull back from Supabase. Only what we need for the
// payload — explicit so type drift is caught at compile time.
type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  total: number | null;
  result: QuoteResult | null;
  highlevel_contact_id: string | null;
  homeworks_sent_at: string | null;
  customer_approved_at: string | null;
  approval_snapshot: unknown;
};

// Narrow shape we read out of approval_snapshot — the rest is untrusted.
// If the quote was customer-approved, this tells us which package name to
// surface to home.works. If no snapshot (operator-initiated resend of a
// never-approved quote), we fall back to a generic label.
type ApprovalSnapshotPartial = {
  customerSelection?: {
    activeName?: string;
    packageId?: string;
  };
};

export async function POST(req: NextRequest) {
  if (!isHomeworksConfigured()) {
    return NextResponse.json(
      { error: 'home.works not configured. Set HOMEWORKS_ZAPIER_WEBHOOK_URL in .env.local' },
      { status: 503 },
    );
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }

  // Admin-gate: same shared secret as the render delete / approve endpoints.
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'ADMIN_SECRET not configured on server' },
      { status: 503 },
    );
  }
  const provided = req.headers.get('x-admin-secret');
  // Audit fix: constant-time compare to avoid leaking the secret via timing.
  if (!safeEqual(provided ?? undefined, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rl = rateLimitResponse(req, { bucket: 'homeworks-send', limit: 10, windowMs: 60_000 });
  if (rl) return rl;

  let body: { quoteId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.quoteId || !UUID_RE.test(body.quoteId)) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, total, result, highlevel_contact_id, homeworks_sent_at, customer_approved_at, approval_snapshot',
    )
    .eq('id', body.quoteId)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Idempotency: refuse to re-send a quote that already went through,
  // unless the caller explicitly overrides. Prevents double-billing if
  // the operator double-clicks the send button.
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === 'true';
  if (quote.homeworks_sent_at && !force) {
    return NextResponse.json(
      {
        error: `Quote was already sent to home.works at ${quote.homeworks_sent_at}. Pass ?force=true to resend.`,
        sentAt: quote.homeworks_sent_at,
      },
      { status: 409 },
    );
  }

  // Build the Zapier payload from the saved quote. We flatten the full
  // pricing breakdown so the Zap's field mapper can reach each value
  // without JavaScript code steps.
  const r = quote.result;
  const lineItems = (r?.lineItems ?? []).map(li => ({
    label: li.label,
    amountUsd: li.amount,
  }));

  const subtotalBeforeDiscountUsd = r?.subtotalBeforeDiscount ?? 0;
  const discountAmountUsd = r?.discountAmount ?? 0;
  const subtotalAfterDiscountUsd = r?.subtotalAfterDiscount ?? 0;
  const rushFeeUsd = r?.rushFeeAmount ?? 0;
  const takedownUsd = r?.takedownAmount ?? 0;
  const taxableAmountUsd = r?.taxableAmount ?? 0;
  const taxAmountUsd = r?.taxAmount ?? 0;
  const totalUsd = r?.total ?? quote.total ?? 0;
  const depositUsd = r?.depositAmount ?? 0;
  const balanceDueUsd = r?.balanceDue ?? 0;
  const minimumApplied = r?.minimumApplied ?? false;

  // Package name for the home.works single-line item. If this is a
  // resend of a customer-approved quote we use the name the customer saw
  // and agreed to. If an operator is sending an un-approved quote for
  // signature/payment, we fall back to a generic label.
  const snapshot = (quote.approval_snapshot ?? null) as ApprovalSnapshotPartial | null;
  const packageName =
    snapshot?.customerSelection?.activeName
    || 'Yule Love Lights — Holiday Lighting Package';

  const homeworksLineItem = buildHomeworksSingleLineItem({
    packageName,
    lineItems,
    subtotalBeforeDiscountUsd,
    discountAmountUsd,
    subtotalAfterDiscountUsd,
    rushFeeUsd,
    takedownUsd,
    minimumApplied,
  });

  const payload: HomeworksPayload = {
    event: 'quote.send',
    quoteId: quote.id,
    highlevelContactId: quote.highlevel_contact_id ?? undefined,
    customer: {
      fullName: quote.customer_name ?? 'Anonymous',
      email: quote.customer_email ?? undefined,
      phone: quote.customer_phone ?? undefined,
      address: quote.customer_address ?? undefined,
    },
    lineItems,
    homeworksLineItem,
    subtotalBeforeDiscountUsd,
    discountAmountUsd,
    subtotalAfterDiscountUsd,
    rushFeeUsd,
    takedownUsd,
    taxableAmountUsd,
    taxAmountUsd,
    totalUsd,
    depositUsd,
    balanceDueUsd,
    minimumApplied,
    notes: undefined,  // TODO wire up when notes field is added to quotes
    sentAt: new Date().toISOString(),
  };

  try {
    const result = await sendQuoteToHomeworks(payload);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? 'Zapier rejected the webhook', response: result.webhookResponse },
        { status: 502 },
      );
    }

    const sentAt = payload.sentAt;
    const { error: updateErr } = await sb
      .from('quotes')
      .update({
        homeworks_sent_at: sentAt,
        homeworks_webhook_response: result.webhookResponse ?? null,
      })
      .eq('id', quote.id);
    if (updateErr) {
      console.warn('[api/integrations/homeworks/send] DB update failed:', updateErr.message);
    }

    return NextResponse.json({ ok: true, sentAt });
  } catch (err) {
    console.error('[api/integrations/homeworks/send] failed:', err);
    if (err instanceof HomeworksError) {
      return NextResponse.json(
        { error: err.message, code: 'homeworks-error' },
        { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
