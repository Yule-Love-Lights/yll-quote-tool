// Customer-triggered quote approval.
// Called when the customer clicks "Approve & Pay Deposit" on the portal.
//
// POST /api/quotes/[id]/approve
// Body:
//   {
//     packageId: 'A'|'B'|'C'|'D',        // which package the customer landed on
//     selectedItemIds: string[],          // which line items are selected
//     activeName: string,                 // package display name ("Build Your Own" etc.)
//     currentTotal: number,               // dollars, what the customer saw
//     currentDeposit: number,             // dollars, what they're paying up front
//     rushSelected: boolean,              // customer's rush add-on toggle (#4)
//     takedownSelected: boolean,          // customer's premium-takedown toggle (#4)
//   }
// Response:
//   { ok: true, sentAt: ISO, homeworksOk: boolean }  — on success
//   { error: string, code?: string }                  — on failure
//
// Auth model: none. The quote ID itself (a 128-bit random UUID) is the
// capability token — if you have the URL, you can approve. This matches
// every other "shareable link" pattern (Stripe invoice links, DocuSign,
// Calendly booking confirmations). If we ever need stronger auth we'd
// add a per-quote short-lived token to the link instead of requiring
// customer login.
//
// Idempotency: if customer_approved_at is already set, returns 409 with
// the prior sentAt. The UI should treat this as "already booked" — not
// as an error — and route the customer to /portal/[id]/approved anyway.
//
// What happens here:
//   1. Load quote row from DB
//   2. Build the approval_snapshot from the request + DB state
//   3. Build the HomeworksPayload from the same data
//   4. Write snapshot + customer_approved_at to the row FIRST (so we
//      never lose the approval even if Zapier fails)
//   5. Fire the Zapier webhook
//   6. On webhook success: write homeworks_sent_at + response
//   7. Return success to the client

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  sendQuoteToHomeworks,
  isHomeworksConfigured,
  buildHomeworksSingleLineItem,
  HomeworksError,
} from '@/lib/integrations/homeworks';
import {
  updateOpportunityStage,
  isHighLevelConfigured,
} from '@/lib/integrations/highlevel';
import type { HomeworksPayload } from '@/lib/integrations/types';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  total: number | null;
  result: QuoteResult | null;
  highlevel_contact_id: string | null;
  highlevel_opportunity_id: string | null;
  customer_approved_at: string | null;
  homeworks_sent_at: string | null;
};

type ApproveBody = {
  packageId?: 'A' | 'B' | 'C' | 'D';
  selectedItemIds?: string[];
  activeName?: string;
  currentTotal?: number;
  currentDeposit?: number;
  rushSelected?: boolean;
  takedownSelected?: boolean;
};

// The snapshot shape — stored in the approval_snapshot jsonb column.
// Kept self-describing so when we read it later we know what it contains
// without cross-referencing code. Not exported because nothing else reads
// this type right now — admin UI can treat it as `unknown` for display.
type ApprovalSnapshot = {
  version: 1;
  approvedAt: string;              // ISO timestamp
  customerSelection: {
    packageId: 'A' | 'B' | 'C' | 'D';
    activeName: string;
    selectedItemIds: string[];
    currentTotalUsd: number;
    currentDepositUsd: number;
    rushSelected: boolean;      // #4 — customer's rush add-on choice
    takedownSelected: boolean;  // #4 — customer's premium-takedown choice
  };
  customer: {
    fullName: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  // Full pricing result as it existed at approval time. If an admin
  // later edits the quote, this snapshot remembers the original.
  pricing: QuoteResult | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }

  // Modest rate limit — a customer isn't going to click this 20×/min,
  // but we want to stop bots from spamming the endpoint.
  const rl = rateLimitResponse(req, { bucket: 'quote-approve', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: ApproveBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate the selection shape. We allow light defaulting because the
  // portal might send a partial selection (e.g., currentTotal missing if
  // client-side state hasn't settled) — but the packageId must be present.
  const packageId = body.packageId;
  if (packageId !== 'A' && packageId !== 'B' && packageId !== 'C' && packageId !== 'D') {
    return NextResponse.json({ error: 'packageId must be A, B, C, or D' }, { status: 400 });
  }
  const selectedItemIds = Array.isArray(body.selectedItemIds)
    ? body.selectedItemIds.filter((x): x is string => typeof x === 'string').slice(0, 200)
    : [];
  const activeName = typeof body.activeName === 'string' ? body.activeName.slice(0, 200) : '';
  const currentTotal = typeof body.currentTotal === 'number' && body.currentTotal >= 0 ? body.currentTotal : 0;
  const currentDeposit = typeof body.currentDeposit === 'number' && body.currentDeposit >= 0 ? body.currentDeposit : 0;
  // #4 — the customer's rush / premium-takedown add-on choices. Recorded in
  // the snapshot (the authoritative record of what they approved); the
  // toggle-inclusive amount is already in currentTotal/currentDeposit.
  const rushSelected = body.rushSelected === true;
  const takedownSelected = body.takedownSelected === true;

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, total, result, highlevel_contact_id, highlevel_opportunity_id, customer_approved_at, homeworks_sent_at',
    )
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Idempotency — customer already approved. Return 409 with prior data
  // so the client can route to the celebration page anyway.
  if (quote.customer_approved_at) {
    return NextResponse.json(
      {
        error: 'Quote already approved',
        code: 'already-approved',
        approvedAt: quote.customer_approved_at,
        sentAt: quote.homeworks_sent_at,
      },
      { status: 409 },
    );
  }

  // Freeze the approval snapshot FIRST, before talking to Zapier.
  // This preserves the customer's consent even if downstream systems
  // fail — we never want to lose the fact that they approved.
  const approvedAt = new Date().toISOString();
  const snapshot: ApprovalSnapshot = {
    version: 1,
    approvedAt,
    customerSelection: {
      packageId,
      activeName,
      selectedItemIds,
      currentTotalUsd: currentTotal,
      currentDepositUsd: currentDeposit,
      rushSelected,
      takedownSelected,
    },
    customer: {
      fullName: quote.customer_name,
      address: quote.customer_address,
      phone: quote.customer_phone,
      email: quote.customer_email,
    },
    pricing: quote.result,
  };

  const { error: snapshotErr } = await sb
    .from('quotes')
    .update({
      customer_approved_at: approvedAt,
      approval_snapshot: snapshot,
    })
    .eq('id', id);

  if (snapshotErr) {
    console.error('[api/quotes/:id/approve] snapshot save failed:', snapshotErr);
    return NextResponse.json(
      { error: `Failed to record approval: ${snapshotErr.message}` },
      { status: 500 },
    );
  }

  // If home.works isn't configured yet, we still succeed the approval
  // locally — the admin gets a heads-up on the next page load via the
  // "approved but not delivered" state. Getting approval → sign gated
  // on Zapier being up would be the wrong trade.
  if (!isHomeworksConfigured()) {
    console.warn('[api/quotes/:id/approve] home.works webhook unconfigured — approval saved locally only');
    return NextResponse.json({
      ok: true,
      approvedAt,
      homeworksOk: false,
      homeworksReason: 'HOMEWORKS_ZAPIER_WEBHOOK_URL not configured',
    });
  }

  // Build the Zapier payload from the quote + approval snapshot.
  const r = quote.result;
  const lineItems = (r?.lineItems ?? []).map(li => ({
    label: li.label,
    amountUsd: li.amount,
  }));

  // Hoist every dollar amount so we can reuse them for the single-line-item
  // roll-up without recomputing.
  const subtotalBeforeDiscountUsd = r?.subtotalBeforeDiscount ?? 0;
  const discountAmountUsd = r?.discountAmount ?? 0;
  const subtotalAfterDiscountUsd = r?.subtotalAfterDiscount ?? 0;
  const rushFeeUsd = r?.rushFeeAmount ?? 0;
  const takedownUsd = r?.takedownAmount ?? 0;
  const taxableAmountUsd = r?.taxableAmount ?? 0;
  const taxAmountUsd = r?.taxAmount ?? 0;
  const totalUsd = r?.total ?? quote.total ?? currentTotal;
  const depositUsd = r?.depositAmount ?? currentDeposit;
  const balanceDueUsd = r?.balanceDue ?? 0;
  const minimumApplied = r?.minimumApplied ?? false;

  // home.works accepts one line item per estimate. We roll the package
  // name into the item name and the full breakdown into the description.
  // Tax/deposit/balance are NOT passed — home.works computes them.
  const homeworksLineItem = buildHomeworksSingleLineItem({
    packageName: activeName || `Package ${packageId}`,
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
    notes: undefined,
    sentAt: approvedAt,
  };

  try {
    const result = await sendQuoteToHomeworks(payload);
    if (!result.ok) {
      // Approval already saved. Log the webhook failure but return
      // success to the customer — the admin panel will surface the
      // "delivery failed, manual resend needed" state.
      console.error('[api/quotes/:id/approve] Zapier webhook rejected:', result);
      return NextResponse.json({
        ok: true,
        approvedAt,
        homeworksOk: false,
        homeworksReason: result.error ?? 'Zapier webhook rejected',
      });
    }

    const { error: webhookUpdateErr } = await sb
      .from('quotes')
      .update({
        homeworks_sent_at: approvedAt,
        homeworks_webhook_response: result.webhookResponse ?? null,
      })
      .eq('id', id);
    if (webhookUpdateErr) {
      console.warn('[api/quotes/:id/approve] webhook sent, DB update failed:', webhookUpdateErr.message);
    }

    // HighLevel: advance opportunity to "Interested" now that the customer
    // approved AND home.works received the estimate. Non-fatal on failure —
    // the approval is already recorded and home.works has the data. An admin
    // can manually move the card if the API call fails.
    //
    // We fire this AFTER the webhook succeeds (not before) so we don't
    // advance the stage on a failed home.works push — that would leave the
    // pipeline lying about the quote's actual state.
    let highlevelStageUpdated = false;
    const stageInterested = process.env.HIGHLEVEL_STAGE_QUOTE_INTERESTED;
    if (quote.highlevel_opportunity_id && isHighLevelConfigured() && stageInterested) {
      try {
        await updateOpportunityStage(quote.highlevel_opportunity_id, stageInterested);
        highlevelStageUpdated = true;
      } catch (hlErr) {
        console.warn('[api/quotes/:id/approve] HL stage → Interested failed:', hlErr);
      }
    }

    return NextResponse.json({
      ok: true,
      approvedAt,
      homeworksOk: true,
      highlevelStageUpdated,
    });
  } catch (err) {
    // Network-level failure to reach Zapier. Approval is still recorded.
    console.error('[api/quotes/:id/approve] Zapier fetch failed:', err);
    const msg = err instanceof HomeworksError
      ? err.message
      : err instanceof Error
        ? err.message
        : 'Unknown error contacting Zapier';
    return NextResponse.json({
      ok: true,
      approvedAt,
      homeworksOk: false,
      homeworksReason: msg,
    });
  }
}
