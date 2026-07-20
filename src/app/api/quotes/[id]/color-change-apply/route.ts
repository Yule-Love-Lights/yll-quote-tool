// Staff apply/dismiss half of the customer colour-change request (ledger #163,
// the counterpart to color-change-request/route.ts's "notify" half).
//
// POST /api/quotes/[id]/color-change-apply   (operator-only)
// Body: { action: 'apply' | 'dismiss', note?: string }
//   - note is OPTIONAL on apply, REQUIRED (non-empty) on dismiss — staff must
//     say why they're turning down a customer's request.
// Response: { ok: true, action, label, colorSchemeId, smsSent?, emailSent? }
//           { error, code? }
//
// Apply re-freezes approval_snapshot.customerSelection to the pending request's
// colour — RE-VALIDATED against the CURRENT live swatch list (never blindly
// trusting the ids stored when the request was filed, in case a scheme was
// edited/removed since) — clears pendingColorRequest, and best-effort notifies
// the customer. Dismiss clears pendingColorRequest and leaves customerSelection
// untouched. Either way a ZERO-DELTA amendment-trail entry is appended for the
// audit record (mirrors free-items/route.ts, ledger #162): delta 0 means
// requiresReconsent / blocksSettlement stay false, so this never disturbs the
// booking or blocks a pending settlement, and totals/deposit/balance are
// byte-identical before and after.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { getAppSettings } from '@/lib/appSettings';
import {
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  isKnownColorSchemeId,
  sanitizeCustomPattern,
} from '@/lib/design/colorSchemes';
import { resolveColorChoice } from '@/lib/inventory/resolveInstalls';
import { computeAmendment, type AmendmentTrailEntry } from '@/lib/amend';
import { resolveAgreedTotal } from '@/lib/agreedTotal';
import {
  sendSms,
  sendEmail,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import {
  COLOR_CHANGE_APPLIED_EMAIL_SUBJECT,
  colorChangeAppliedSmsBody,
  colorChangeAppliedEmailHtml,
} from '@/lib/integrations/quoteMessages';
// Reuse the request route's label helper — it's the exact same "how do we
// describe this colour to a human" logic, and its own tests already cover it.
import { colorChangeLabel } from '../color-change-request/route';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 500;

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type PendingColorRequest = {
  colorSchemeId: string;
  customPattern: string[];
  colorIds: string[] | null;
  label: string;
  requestedAt: string;
};

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  highlevel_contact_id: string | null;
  service_type: string | null;
  customer_approved_at: string | null;
  deposit_amount_usd: number | null;
  total: number | null;
  result: QuoteResult | null;
  is_test: boolean;
  approval_snapshot: {
    customerSelection?: {
      colorSchemeId?: string;
      customPattern?: string[];
      colorIds?: string[] | null;
      // Read by resolveAgreedTotal (the money-invariant zero-delta anchor below).
      currentTotalUsd?: number | null;
      [key: string]: unknown;
    };
    pendingColorRequest?: PendingColorRequest;
    amendments?: AmendmentTrailEntry[];
    [key: string]: unknown;
  } | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { action?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = body.action;
  if (action !== 'apply' && action !== 'dismiss') {
    return NextResponse.json({ error: "action must be 'apply' or 'dismiss'", code: 'bad-action' }, { status: 400 });
  }
  const note = (typeof body.note === 'string' ? body.note.trim() : '').slice(0, NOTE_MAX);
  if (action === 'dismiss' && !note) {
    return NextResponse.json(
      { error: 'A note is required to dismiss a colour change request', code: 'note-required' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_email, customer_phone, highlevel_contact_id, service_type, customer_approved_at, deposit_amount_usd, total, result, is_test, approval_snapshot',
    )
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  const snap = quote.approval_snapshot ?? {};
  const pending = snap.pendingColorRequest;
  if (!pending) {
    return NextResponse.json(
      { error: 'No pending colour change request on this quote', code: 'no-pending-request' },
      { status: 409 },
    );
  }
  // Only an approved/booked order has a frozen selection to re-freeze — mirrors
  // the request route's own gate.
  if (!quote.customer_approved_at || !snap.customerSelection) {
    return NextResponse.json(
      { error: 'This order is not booked yet', code: 'not-booked' },
      { status: 409 },
    );
  }

  // ── Resolve the label + (for apply) the re-validated colour ────────────────
  let colorSchemeId: string;
  let customPattern: string[];
  let colorIds: string[] | null;
  let label: string;

  if (action === 'apply') {
    // Re-validate against the CURRENT live swatch list for this vertical — a
    // scheme edited or removed in Settings since the request was filed must not
    // blindly re-freeze a stale id; re-resolve colorIds too (never trust the
    // ones stored on the pending request).
    const isPermanent = quote.service_type === 'permanent';
    const { swatches, permanentSwatches } = await getAppSettings();
    const activeSchemes = isPermanent ? permanentSwatches.schemes : swatches.schemes;
    const activeBuildable = isPermanent ? permanentSwatches.buildableColorIds : swatches.buildableColorIds;

    const requestedSchemeId = isKnownColorSchemeId(pending.colorSchemeId, activeSchemes)
      ? pending.colorSchemeId
      : DEFAULT_COLOR_SCHEME_ID;
    customPattern =
      requestedSchemeId === CUSTOM_SCHEME_ID ? sanitizeCustomPattern(pending.customPattern, activeBuildable) : [];
    // Collapse an empty custom pick back to the default (mirrors approve/request routes).
    colorSchemeId =
      requestedSchemeId === CUSTOM_SCHEME_ID && customPattern.length === 0
        ? DEFAULT_COLOR_SCHEME_ID
        : requestedSchemeId;
    colorIds = resolveColorChoice(colorSchemeId, customPattern, activeSchemes);
    label = colorChangeLabel(colorSchemeId, customPattern);
  } else {
    // Dismiss — nothing is re-applied to the booking; echo the pending
    // request's own label/id for the response + audit trail.
    colorSchemeId = typeof pending.colorSchemeId === 'string' ? pending.colorSchemeId : DEFAULT_COLOR_SCHEME_ID;
    customPattern = Array.isArray(pending.customPattern) ? pending.customPattern : [];
    colorIds = null;
    label = typeof pending.label === 'string' ? pending.label : colorChangeLabel(colorSchemeId, customPattern);
  }

  // ── Zero-delta audit entry ──────────────────────────────────────────────────
  // Anchored on the CURRENT agreed total (resolveAgreedTotal — the last
  // amendment's new_total, else the frozen currentTotalUsd, else the result),
  // NOT the stale approval-time total, so a prior real amendment's total isn't
  // clobbered by a lower stale figure (mirrors free-items/route.ts exactly).
  const agreedTotal = resolveAgreedTotal(snap, quote.result);
  const depositPaid = quote.deposit_amount_usd ?? 0;
  const previousBalance = Math.max(0, agreedTotal - depositPaid);
  const op = await getOperator();
  const by = op?.name ? `staff:${op.name}` : op?.email ? `staff:${op.email}` : 'staff';
  const reason =
    action === 'apply'
      ? note
        ? `Colour change applied: ${label} — ${note}`
        : `Colour change applied: ${label}`
      : `Colour change dismissed: ${label} — ${note}`;
  let amendment: AmendmentTrailEntry;
  try {
    amendment = computeAmendment({
      previousTotal: agreedTotal,
      depositPaid,
      previousBalance,
      newTotal: agreedTotal,
      by,
      reason,
      lineItemChanges: [],
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not record the change' },
      { status: 500 },
    );
  }
  const priorAmendments = Array.isArray(snap.amendments) ? snap.amendments : [];

  // pendingColorRequest is ALWAYS cleared (apply consumes it, dismiss discards
  // it); customerSelection only moves on apply.
  const restSnap = { ...snap };
  delete restSnap.pendingColorRequest;
  const newSnapshot =
    action === 'apply'
      ? {
          ...restSnap,
          customerSelection: {
            ...restSnap.customerSelection,
            colorSchemeId,
            customPattern,
            colorIds,
          },
          amendments: [...priorAmendments, amendment],
        }
      : {
          ...restSnap,
          amendments: [...priorAmendments, amendment],
        };

  // Atomically bind the write to the exact snapshot we read (same race class
  // #580's F-014 fixed in free-items): a concurrent amendment / free-item edit
  // / another color-change action that lands between our read and this write
  // changes the jsonb value, so this stale writer can't clobber it.
  const { data: updatedQuotes, error: upErr } = await sb
    .from('quotes')
    .update({ approval_snapshot: newSnapshot })
    .eq('id', id)
    .eq('approval_snapshot', JSON.stringify(quote.approval_snapshot))
    .select('id');
  if (upErr) {
    console.error('[api/quotes/:id/color-change-apply] update failed:', upErr);
    return NextResponse.json({ error: 'Failed to save the change' }, { status: 500 });
  }
  if (!updatedQuotes || updatedQuotes.length === 0) {
    return NextResponse.json(
      { error: 'The order changed while you were editing — please retry.', code: 'concurrent-edit' },
      { status: 409 },
    );
  }

  // Notify the customer on APPLY only (a dismiss changes nothing for them) —
  // best-effort, never fails the request. Suppressed for a Test Quote (#93),
  // same convention as every other customer-facing send.
  let smsSent = false;
  let emailSent = false;
  if (action === 'apply' && !quote.is_test && isHighLevelConfigured() && quote.highlevel_contact_id) {
    const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
    const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    try {
      await sendSms({
        contactId: quote.highlevel_contact_id,
        message: colorChangeAppliedSmsBody(label),
        fromNumber,
      });
      smsSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/color-change-apply] customer SMS failed:', hlErrorMessage(err));
    }
    try {
      await sendEmail({
        contactId: quote.highlevel_contact_id,
        subject: COLOR_CHANGE_APPLIED_EMAIL_SUBJECT,
        html: colorChangeAppliedEmailHtml(firstName, label),
        emailFrom,
      });
      emailSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/color-change-apply] customer email failed:', hlErrorMessage(err));
    }
  }

  return NextResponse.json({
    ok: true,
    action,
    label,
    colorSchemeId,
    ...(action === 'apply' ? { smsSent, emailSent } : {}),
  });
}
