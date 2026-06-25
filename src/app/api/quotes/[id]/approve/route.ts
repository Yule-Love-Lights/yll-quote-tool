// Customer-triggered quote approval.
// Called when the customer clicks "Approve" on the portal.
//
// POST /api/quotes/[id]/approve
// Body:
//   {
//     packageId: 'A'|'B'|'C'|'D',        // which package the customer landed on
//     selectedItemIds: string[],          // which line items are selected
//     activeName: string,                 // package display name ("Build Your Own" etc.)
//     currentTotal: number,               // dollars, what the customer saw
//     currentDeposit: number,             // dollars, the 50% deposit
//     rushSelected: boolean,              // customer's rush add-on toggle (#4)
//     takedownSelected: boolean,          // customer's premium-takedown toggle (#4)
//   }
// Response:
//   { ok: true, approvedAt: ISO, customerSmsSent, customerEmailSent, internalEmailSent }
//   { error: string, code?: string }
//
// Auth model: none. The quote ID itself (a 128-bit random UUID) is the
// capability token — if you have the URL, you can approve. This matches
// every other "shareable link" pattern (Stripe invoice links, DocuSign,
// Calendly booking confirmations).
//
// Idempotency: if customer_approved_at is already set, returns 409 with
// the prior approvedAt. The UI treats this as "already booked" — not an
// error — and routes the customer to /portal/[id]/approved anyway. This
// also guarantees the notifications below fire at most once.
//
// TEMPORARY (pre-Valor) deposit flow — what happens here:
//   1. Load quote row from DB
//   2. Build + save the approval_snapshot + customer_approved_at FIRST, so the
//      approval is never lost even if the messaging below fails
//   3. Text + email the CUSTOMER: "you're approved — we'll reach out to collect
//      your 50% deposit and lock in your install date"
//   4. Email OURSELVES (the sales@ GHL contact) to go collect the deposit
//   All messaging is best-effort and non-fatal. Per Jason there is NO GHL stage
//   move on approve — the card stays at "Bid Sent"; the internal email is the
//   staff signal. When Valor lands (#38), the payment step runs before this and
//   the receipt + any GHL move fire on payment-confirmed instead.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  sendSms,
  sendEmail,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import {
  APPROVAL_EMAIL_SUBJECT,
  approvalSmsBody,
  approvalEmailHtml,
  internalApprovalEmailSubject,
  internalApprovalEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  isKnownColorSchemeId,
  sanitizeCustomPattern,
} from '@/lib/design/colorSchemes';
import { isValorCheckoutEnabled } from '@/lib/integrations/valorCheckout';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  total: number | null;
  result: QuoteResult | null;
  highlevel_contact_id: string | null;
  customer_approved_at: string | null;
};

type ApproveBody = {
  packageId?: 'A' | 'B' | 'C' | 'D';
  selectedItemIds?: string[];
  activeName?: string;
  currentTotal?: number;
  currentDeposit?: number;
  rushSelected?: boolean;
  takedownSelected?: boolean;
  colorSchemeId?: string;
  customPattern?: unknown; // #49 — build-your-own pattern (sanitized server-side)
  installTiming?: 'none' | 'september' | 'october';
  installDiscountUsd?: number;
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
    colorSchemeId: string;      // #10 — customer's light color/pattern choice
    customPattern: string[];    // #49 — build-your-own pattern (color ids), [] unless colorSchemeId === 'custom'
    installTiming: 'none' | 'september' | 'october'; // #40 — early-install choice
    installDiscountUsd: number; // #40 — dollars discounted by the early-install choice
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
  // #10 — the customer's light color/pattern choice. A short scheme id; recorded
  // in the snapshot as the authoritative record of what they approved. Validated
  // against the known scheme set (presets + 'custom'); anything unknown/absent
  // falls back to 'as-designed' (older clients / no design / junk POST).
  const requestedSchemeId = isKnownColorSchemeId(body.colorSchemeId)
    ? body.colorSchemeId
    : DEFAULT_COLOR_SCHEME_ID;
  // #49 — build-your-own pattern, sanitized (valid palette ids only, capped).
  // Only meaningful when they chose 'custom'; empty otherwise.
  const customPattern =
    requestedSchemeId === CUSTOM_SCHEME_ID ? sanitizeCustomPattern(body.customPattern) : [];
  // Collapse an empty custom selection back to the default so the frozen snapshot
  // is self-consistent: 'custom' with zero colors renders identically to
  // 'as-designed', so we store 'as-designed' rather than a contradictory record.
  const colorSchemeId =
    requestedSchemeId === CUSTOM_SCHEME_ID && customPattern.length === 0
      ? DEFAULT_COLOR_SCHEME_ID
      : requestedSchemeId;
  // #40 — the customer's early-install timing choice + the resulting discount.
  // Recorded in the snapshot (the authoritative record of what they approved);
  // the discounted amount is already baked into currentTotal/currentDeposit.
  const installTiming =
    body.installTiming === 'september' || body.installTiming === 'october'
      ? body.installTiming
      : 'none';
  const installDiscountUsd =
    typeof body.installDiscountUsd === 'number' && body.installDiscountUsd >= 0
      ? body.installDiscountUsd
      : 0;

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, total, result, highlevel_contact_id, customer_approved_at',
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
  // so the client can route to the celebration page anyway. This also
  // ensures the notifications below never double-fire.
  if (quote.customer_approved_at) {
    return NextResponse.json(
      {
        error: 'Quote already approved',
        code: 'already-approved',
        approvedAt: quote.customer_approved_at,
      },
      { status: 409 },
    );
  }

  // Freeze the approval snapshot FIRST, before any messaging. This preserves
  // the customer's consent even if the notifications below fail — we never
  // want to lose the fact that they approved.
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
      colorSchemeId,
      customPattern,
      installTiming,
      installDiscountUsd,
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

  // Approval is now recorded. Notify the customer and ourselves — all
  // best-effort, because a messaging hiccup must never undo the approval.
  let customerSmsSent = false;
  let customerEmailSent = false;
  let internalEmailSent = false;
  let messageError: string | undefined;

  if (isHighLevelConfigured()) {
    const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const portalUrl = `${baseUrl}/portal/${id}`;
    const adminUrl = `${baseUrl}/quote/${id}`;
    const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
    const depositUsd = quote.result?.depositAmount ?? currentDeposit;
    const totalUsd = quote.result?.total ?? quote.total ?? currentTotal;

    // 1. Customer — confirm approval + that we'll reach out for the deposit.
    //    SMS needs the contact to have a phone (real customers do); a 422 there
    //    is non-fatal. Both messages land in the GHL Conversations tab.
    //    #38: SKIPPED when the embedded checkout is ON — the customer pays their
    //    deposit online next and gets their receipt from the payment-confirmed
    //    webhook instead, so this "we'll reach out to collect it" message would
    //    be wrong. With the checkout OFF (today) it fires as the placeholder.
    if (!isValorCheckoutEnabled() && quote.highlevel_contact_id) {
      try {
        await sendSms({
          contactId: quote.highlevel_contact_id,
          message: approvalSmsBody(firstName, depositUsd, phone),
          fromNumber,
        });
        customerSmsSent = true;
      } catch (err) {
        console.warn('[api/quotes/:id/approve] customer SMS failed:', hlErrorMessage(err));
        messageError = hlErrorMessage(err);
      }
      try {
        await sendEmail({
          contactId: quote.highlevel_contact_id,
          subject: APPROVAL_EMAIL_SUBJECT,
          html: approvalEmailHtml(firstName, depositUsd, portalUrl, phone),
          emailFrom,
        });
        customerEmailSent = true;
      } catch (err) {
        console.warn('[api/quotes/:id/approve] customer email failed:', hlErrorMessage(err));
        messageError = (messageError ? `${messageError}; ` : '') + hlErrorMessage(err);
      }
    }

    // 2. Ourselves — email the "go collect the deposit" notification to the
    //    internal GHL contact (sales@, HIGHLEVEL_INTERNAL_CONTACT_ID). Skipped
    //    cleanly if the var isn't set.
    const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    if (internalContactId) {
      try {
        await sendEmail({
          contactId: internalContactId,
          subject: internalApprovalEmailSubject(quote.customer_name),
          html: internalApprovalEmailHtml({
            customerName: quote.customer_name,
            address: quote.customer_address,
            phone: quote.customer_phone,
            email: quote.customer_email,
            totalUsd,
            depositUsd,
            packageName: activeName || `Package ${packageId}`,
            installTiming,
            rushSelected,
            takedownSelected,
            portalUrl,
            adminUrl,
          }),
          emailFrom,
        });
        internalEmailSent = true;
      } catch (err) {
        console.warn('[api/quotes/:id/approve] internal email failed:', hlErrorMessage(err));
        messageError = (messageError ? `${messageError}; ` : '') + hlErrorMessage(err);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    approvedAt,
    customerSmsSent,
    customerEmailSent,
    internalEmailSent,
    messageError,
  });
}
