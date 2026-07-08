// Send a saved quote to home.works via the Zapier Catch Hook. Triggered
// from the admin UI when the operator clicks "Send to home.works for
// signature + payment."
//
// POST /api/integrations/homeworks/send  (operator-only — session perimeter, #81)
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
import { requireOperator } from '@/lib/auth/supabaseServer';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';
import { resolveAgreedTotal } from '@/lib/agreedTotal';
import { roundMoneyGuarded as round2 } from '@/lib/money';

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
// Widened (money fix): `currentTotalUsd` + `amendments` feed resolveAgreedTotal
// (src/lib/agreedTotal.ts) so a RESEND of an already-approved quote bills the
// AGREED (possibly partial) total, not the full engine-priced result — the
// cast used to silently drop currentTotalUsd, so a resend of a partial
// approval billed home.works for more than the customer agreed to.
type ApprovalSnapshotPartial = {
  customerSelection?: {
    activeName?: string;
    packageId?: string;
    currentTotalUsd?: number | null;
  } | null;
  amendments?: Array<{ new_total?: number | null }> | null;
};

export async function POST(req: NextRequest) {
  // Operator-gate (ledger #81): auth FIRST — the session perimeter covers this
  // route; this per-route guard is defense in depth, DORMANT until
  // AUTH_GATE_ENABLED=true.
  const denied = await requireOperator();
  if (denied) return denied;

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

  // ATOMIC CLAIM (MEDIUM double-send fix): the read-then-check above is only a
  // fast path. Unlike /signed (an inbound webhook whose external call is a
  // best-effort HighLevel stage move fired AFTER the DB stamp), the external
  // call below is what CREATES the real home.works estimate — it must never
  // fire twice for one logical send. Compare-and-swap on the exact value we
  // just read: a normal first send claims `homeworks_sent_at IS NULL`; a
  // `?force=true` resend claims off the previous sentAt. Only the request
  // whose read is still current wins the claim; the loser updates 0 rows and
  // bails with 409 instead of double-firing Zapier. sentAt is decided now
  // (not after the send) so the claimed value is exactly what gets stamped.
  const sentAt = new Date().toISOString();
  const previousSentAt = quote.homeworks_sent_at;
  const claimBase = sb.from('quotes').update({ homeworks_sent_at: sentAt }).eq('id', quote.id);
  const { data: claimed, error: claimErr } = await (previousSentAt
    ? claimBase.eq('homeworks_sent_at', previousSentAt)
    : claimBase.is('homeworks_sent_at', null)
  ).select('id');
  if (claimErr) {
    return NextResponse.json(
      { error: `Failed to claim quote for sending: ${claimErr.message}` },
      { status: 500 },
    );
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json(
      { error: 'Quote is already being sent (or was just sent) to home.works — retry in a moment.' },
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

  // HIGH money fix: this route resends an ALREADY-APPROVED quote, but the
  // customer approves a SELECTION on the portal (deselecting items, picking
  // the cheaper roofline tier, toggling rush/takedown) — r.* is the FULL
  // engine-priced result across every input, not what was agreed to.
  // resolveAgreedTotal (src/lib/agreedTotal.ts, mirrors invoices.ts) is the
  // single source of truth for the AGREED total; scale every dollar figure
  // below by the same ratio so the whole breakdown — including
  // homeworksLineItem.totalUsd, the number home.works actually bills off of —
  // is consistent with the agreed total instead of the full engine total.
  const snapshot = (quote.approval_snapshot ?? null) as ApprovalSnapshotPartial | null;
  const fullTotal = r?.total ?? quote.total ?? 0;
  const agreedTotal = resolveAgreedTotal(snapshot, { total: fullTotal });
  const scale = fullTotal > 0 ? agreedTotal / fullTotal : 1;
  const scaleMoney = (n: number) => round2(n * scale);

  const subtotalBeforeDiscountUsd = scaleMoney(r?.subtotalBeforeDiscount ?? 0);
  const discountAmountUsd = scaleMoney(r?.discountAmount ?? 0);
  const subtotalAfterDiscountUsd = scaleMoney(r?.subtotalAfterDiscount ?? 0);
  const rushFeeUsd = scaleMoney(r?.rushFeeAmount ?? 0);
  const takedownUsd = scaleMoney(r?.takedownAmount ?? 0);
  const taxableAmountUsd = scaleMoney(r?.taxableAmount ?? 0);
  const taxAmountUsd = scaleMoney(r?.taxAmount ?? 0);
  const totalUsd = agreedTotal;
  const depositUsd = scaleMoney(r?.depositAmount ?? 0);
  const balanceDueUsd = scaleMoney(r?.balanceDue ?? 0);
  const minimumApplied = r?.minimumApplied ?? false;

  // Package name for the home.works single-line item. If this is a
  // resend of a customer-approved quote we use the name the customer saw
  // and agreed to. If an operator is sending an un-approved quote for
  // signature/payment, we fall back to a generic label.
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
    sentAt,
  };

  try {
    const result = await sendQuoteToHomeworks(payload);
    if (!result.ok) {
      // The claim above already stamped homeworks_sent_at, but Zapier
      // rejected the send — nothing actually went out, so release the claim
      // (restore the pre-claim value) rather than leave the quote falsely
      // marked sent and permanently blocked from a real retry.
      await releaseClaim(sb, quote.id, previousSentAt);
      return NextResponse.json(
        { error: result.error ?? 'Zapier rejected the webhook', response: result.webhookResponse },
        { status: 502 },
      );
    }

    // homeworks_sent_at is already durably stamped by the claim above (before
    // the send fired) — this write only attaches the webhook response for
    // reference, so a failure here can't cause a double-send on retry.
    const { error: updateErr } = await sb
      .from('quotes')
      .update({ homeworks_webhook_response: result.webhookResponse ?? null })
      .eq('id', quote.id);
    if (updateErr) {
      console.warn(
        '[api/integrations/homeworks/send] webhook-response stamp failed (send already succeeded; sentAt already recorded):',
        { quoteId: quote.id, error: updateErr.message },
      );
      return NextResponse.json({ ok: true, sentAt, sentRecorded: true, dbSyncFailed: true });
    }

    return NextResponse.json({ ok: true, sentAt });
  } catch (err) {
    // The send itself threw (network/config error) — nothing reached Zapier,
    // so release the claim just like the !result.ok branch above.
    await releaseClaim(sb, quote.id, previousSentAt);
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

// Roll back the pre-claim stamp when the external send never actually
// reached Zapier (rejected or threw), so the quote isn't stuck permanently
// "sent" — which would block every future retry via the idempotency guard
// above — for a request that never fired. Best-effort: a failure here is
// logged loudly but must not mask the original send error to the caller.
async function releaseClaim(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  quoteId: string,
  previousSentAt: string | null,
): Promise<void> {
  const { error } = await sb
    .from('quotes')
    .update({ homeworks_sent_at: previousSentAt })
    .eq('id', quoteId);
  if (error) {
    console.error(
      '[api/integrations/homeworks/send] claim rollback failed — quote may be stuck as "sent":',
      { quoteId, error: error.message },
    );
  }
}
