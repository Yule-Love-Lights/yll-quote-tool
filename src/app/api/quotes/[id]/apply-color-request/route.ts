// Staff APPLY / DISMISS a pending customer colour-change request (ledger #163
// Slice B). Operator-gated.
//
// POST /api/quotes/[id]/apply-color-request
// Body: { action: 'apply' } | { action: 'dismiss', reason: string }
// Response (#169):
//   apply   → { ok, action: 'apply', label, smsSent, emailSent, notifySkipped }
//             smsSent/emailSent report the customer notify legs so the panel can
//             tell staff when a send FAILED (call the customer); notifySkipped is
//             true when no notify was attempted at all (test quote / HL not
//             configured / no linked contact) — expected, not a failure.
//   dismiss → { ok, action: 'dismiss' }   (silent by design — staff calls them)
//   error   → { error, code? }
//
// Slice A recorded approval_snapshot.pendingColorRequest when a booked customer
// asked for a different light colour. Here staff either APPLY it — re-freezing
// the booked order's colour into approval_snapshot.customerSelection (so the
// install crew uses it) — or DISMISS it with a reason. Colour is $0, so the
// order TOTAL / deposit / balance are INVARIANT (asserted below); only the
// frozen colour (which drives the #92 materials list) changes. The change rides
// the amendment trail as a ZERO-delta entry so every settlement gate treats it
// as the cosmetic change it is. On apply we RE-VALIDATE the requested colour
// against the CURRENT swatch list (a swatch removed since the request degrades
// to as-designed, exactly like the approve route) rather than blind-trusting the
// stored values.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { computeAmendment, type AmendmentTrailEntry } from '@/lib/amend';
import { resolveAgreedTotal } from '@/lib/agreedTotal';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { getAppSettings } from '@/lib/appSettings';
import {
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  isKnownColorSchemeId,
  sanitizeCustomPattern,
  getColorScheme,
} from '@/lib/design/colorSchemes';
import { resolveColorChoice } from '@/lib/inventory/resolveInstalls';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';
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

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;

type PendingColorRequest = {
  colorSchemeId?: string;
  customPattern?: string[];
  colorIds?: string[] | null;
  label?: string;
};

type CustomerSelection = {
  colorSchemeId?: string;
  customPattern?: string[];
  colorIds?: string[] | null;
  currentTotalUsd?: number;
  [key: string]: unknown;
};

type QuoteRow = {
  id: string;
  status: QuoteStatus | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  deposit_amount_usd: number | null;
  total: number | null;
  result: QuoteResult | null;
  service_type: string | null;
  // #163 notify-on-apply (owner decision): who to text/email once the colour is
  // applied. is_test suppresses the send (the #93 Test-Quote convention).
  customer_name: string | null;
  highlevel_contact_id: string | null;
  is_test: boolean;
  approval_snapshot: {
    customerSelection?: CustomerSelection;
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

  let body: { action?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = body.action;
  if (action !== 'apply' && action !== 'dismiss') {
    return NextResponse.json({ error: "action must be 'apply' or 'dismiss'", code: 'bad-action' }, { status: 400 });
  }
  // Dismiss requires a reason (owner decision) — validated before any DB work.
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (action === 'dismiss') {
    if (!reason) {
      return NextResponse.json({ error: 'A reason is required to dismiss', code: 'reason-required' }, { status: 400 });
    }
    if (reason.length > MAX_REASON) {
      return NextResponse.json({ error: `Reason must be <= ${MAX_REASON} characters` }, { status: 400 });
    }
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, status, customer_approved_at, deposit_paid_at, deposit_amount_usd, total, result, service_type, customer_name, highlevel_contact_id, is_test, approval_snapshot',
    )
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  const snap = quote.approval_snapshot ?? {};
  const customerSelection = snap.customerSelection;
  const pending = snap.pendingColorRequest;
  if (!quote.customer_approved_at || !customerSelection) {
    return NextResponse.json({ error: 'Order is not booked', code: 'not-booked' }, { status: 409 });
  }
  if (!pending || typeof pending !== 'object') {
    // Idempotent: nothing pending (already applied/dismissed, or never requested).
    return NextResponse.json({ error: 'No pending colour request', code: 'nothing-pending' }, { status: 409 });
  }

  const op = await getOperator();
  const by = op?.name ? `staff:${op.name}` : op?.email ? `staff:${op.email}` : 'staff';
  // inbox_items.handled_by is a uuid FK (auth.users) — the real operator uuid
  // (or NULL), never the `by` display string above (#208: `by` was being
  // written straight into handled_by, which silently failed the WHOLE update
  // on every call since Postgres rejects non-uuid text for a uuid column).
  const operatorId = op?.id ?? null;

  // ── DISMISS ────────────────────────────────────────────────────────────────
  // Allowed even on a terminal order (clearing a stranded marker is safe). CAS on
  // the full snapshot so a concurrent amend is never clobbered.
  if (action === 'dismiss') {
    const { data: freshRow } = await sb
      .from('quotes')
      .select('approval_snapshot')
      .eq('id', id)
      .maybeSingle<{ approval_snapshot: typeof snap | null }>();
    const priorSnapshot = freshRow?.approval_snapshot ?? snap;
    if (!priorSnapshot.pendingColorRequest) {
      return NextResponse.json({ error: 'No pending colour request', code: 'nothing-pending' }, { status: 409 });
    }
    const { pendingColorRequest: _dropped, ...restSnap } = priorSnapshot;
    void _dropped;
    const { data: updatedRows, error: upErr } = await sb
      .from('quotes')
      .update({ approval_snapshot: restSnap })
      .eq('id', id)
      .eq('approval_snapshot', JSON.stringify(priorSnapshot))
      .select('id');
    if (upErr) {
      console.error('[api/quotes/:id/apply-color-request] dismiss save failed:', upErr);
      return NextResponse.json({ error: 'Could not dismiss the request' }, { status: 500 });
    }
    if (!updatedRows || updatedRows.length === 0) {
      return NextResponse.json({ error: 'The order was just updated — please retry.', code: 'concurrent-edit' }, { status: 409 });
    }
    await resolveInboxRequest(sb, id, operatorId, `Dismissed colour change: ${reason}`);
    return NextResponse.json({ ok: true, action: 'dismiss' });
  }

  // APPLY only past here — reject a terminal order (re-freezing a colour onto a
  // cancelled/declined/abandoned order is wrong; the dismiss above stays allowed).
  const lifecycle = deriveStatus({
    quote_sent_at: null,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    status: quote.status,
  });
  if (lifecycle === 'cancelled' || lifecycle === 'declined' || lifecycle === 'abandoned') {
    return NextResponse.json({ error: `Cannot act on a ${lifecycle} order`, code: 'not-editable' }, { status: 409 });
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────
  // Re-validate the requested colour against the CURRENT swatch list for this
  // vertical (a swatch removed since the request degrades to as-designed, like
  // the approve route) — never blind-trust the stored ids.
  const isPermanent = quote.service_type === 'permanent';
  const { swatches, permanentSwatches } = await getAppSettings();
  const activeSchemes = isPermanent ? permanentSwatches.schemes : swatches.schemes;
  const activeBuildable = isPermanent ? permanentSwatches.buildableColorIds : swatches.buildableColorIds;

  const requestedSchemeId = isKnownColorSchemeId(pending.colorSchemeId, activeSchemes)
    ? (pending.colorSchemeId as string)
    : DEFAULT_COLOR_SCHEME_ID;
  const customPattern =
    requestedSchemeId === CUSTOM_SCHEME_ID
      ? sanitizeCustomPattern(pending.customPattern, activeBuildable)
      : [];
  const colorSchemeId =
    requestedSchemeId === CUSTOM_SCHEME_ID && customPattern.length === 0
      ? DEFAULT_COLOR_SCHEME_ID
      : requestedSchemeId;
  const colorIds = resolveColorChoice(colorSchemeId, customPattern, activeSchemes);
  // Label the ACTUALLY-frozen colour, not the stale request-time label — after a
  // re-validation degrade the audit trail must not claim a colour we didn't apply.
  const label =
    colorSchemeId === CUSTOM_SCHEME_ID || customPattern.length > 0
      ? `Custom pattern (${customPattern.length} colour${customPattern.length === 1 ? '' : 's'})`
      : getColorScheme(colorSchemeId).label;

  // Zero-delta amendment: colour is $0, so the agreed total is unchanged. The
  // entry rides the audit trail; requiresReconsent / blocksSettlement stay false.
  const agreedTotal = resolveAgreedTotal(snap, quote.result);
  const depositPaid = quote.deposit_amount_usd ?? 0;
  const previousBalance = Math.max(0, agreedTotal - depositPaid);
  let amendment: AmendmentTrailEntry;
  try {
    amendment = computeAmendment({
      previousTotal: agreedTotal,
      depositPaid,
      previousBalance,
      newTotal: agreedTotal,
      by,
      reason: `Applied colour change: ${label}`,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not record the change' }, { status: 500 });
  }
  // Defense-in-depth: this path never touches the total (colour is $0).
  if (amendment.delta !== 0) {
    console.error('[api/quotes/:id/apply-color-request] non-zero delta blocked', id, amendment.delta);
    return NextResponse.json({ error: 'Blocked: this change would move the total', code: 'total-drift' }, { status: 500 });
  }

  // Persist. Build the new snapshot from the SAME snapshot we derived the colour
  // from (`snap`) and CAS on `snap` itself, mirroring amend/route.ts. The colour we
  // freeze comes from snap.pendingColorRequest, so the CAS MUST be on snap: then ANY
  // concurrent change — a staff amend appending to the trail, OR the customer
  // re-submitting a different colour after our read — trips a 409 (staff retry),
  // instead of us freezing a STALE colour or clobbering the amend. Re-freeze the
  // colour into customerSelection, drop pendingColorRequest, append the zero-delta entry.
  const priorAmendments = Array.isArray(snap.amendments) ? snap.amendments : [];
  const { pendingColorRequest: _drop, ...restSnap } = snap;
  void _drop;
  const newSnapshot = {
    ...restSnap,
    customerSelection: {
      ...customerSelection,
      colorSchemeId,
      customPattern,
      colorIds,
    },
    amendments: [...priorAmendments, amendment],
  };
  const { data: updatedRows, error: upErr } = await sb
    .from('quotes')
    .update({ approval_snapshot: newSnapshot })
    .eq('id', id)
    // Serialize jsonb explicitly — PostgREST string-interpolates filter values.
    .eq('approval_snapshot', JSON.stringify(snap))
    .select('id');
  if (upErr) {
    console.error('[api/quotes/:id/apply-color-request] apply save failed:', upErr);
    return NextResponse.json({ error: 'Could not apply the colour change' }, { status: 500 });
  }
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json({ error: 'The order changed while you were applying — please retry.', code: 'concurrent-edit' }, { status: 409 });
  }
  await resolveInboxRequest(sb, id, operatorId, `Applied colour change: ${label}`);

  // Notify the customer their colour change is locked in (owner decision:
  // apply notifies; dismiss stays silent — staff calls them). Best-effort,
  // never fails the request; suppressed for a Test Quote (#93), same
  // convention as every other customer-facing send.
  let smsSent = false;
  let emailSent = false;
  // #169: distinguish "no notify attempted" (expected: test quote / HL not
  // configured / no linked contact) from "attempted and FAILED" — the panel
  // shows a call-the-customer warning only for the latter.
  const contactId = quote.highlevel_contact_id;
  const notifySkipped = quote.is_test || !isHighLevelConfigured() || !contactId;
  if (!notifySkipped && contactId) {
    const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
    const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    try {
      await sendSms({
        contactId,
        message: colorChangeAppliedSmsBody(label),
        fromNumber,
      });
      smsSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/apply-color-request] customer SMS failed:', hlErrorMessage(err));
    }
    try {
      await sendEmail({
        contactId,
        subject: COLOR_CHANGE_APPLIED_EMAIL_SUBJECT,
        html: colorChangeAppliedEmailHtml(firstName, label),
        emailFrom,
      });
      emailSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/apply-color-request] customer email failed:', hlErrorMessage(err));
    }
  }

  return NextResponse.json({ ok: true, action: 'apply', label, smsSent, emailSent, notifySkipped });
}

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

/** Best-effort: mark the Slice-A inbox notification (quotetool / <id>:color-request)
 *  handled so it clears from the operator queue. Never fails the request.
 *  `operatorId` must be a real auth.users uuid, or null — inbox_items.handled_by
 *  is a nullable `uuid` column ("NULL when system auto-resolved" per its schema
 *  comment); never pass a display name/email string here (#208). */
async function resolveInboxRequest(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  quoteId: string,
  operatorId: string | null,
  detail: string,
): Promise<void> {
  try {
    const { data } = await sb
      .from('inbox_items')
      .select('id')
      .eq('source', 'quotetool')
      .eq('external_id', `${quoteId}:color-request`)
      .maybeSingle();
    const itemId = (data as { id?: string } | null)?.id;
    if (!itemId) return;
    const { error: updateErr } = await sb
      .from('inbox_items')
      .update({ status: 'completed', handled_by: operatorId, handled_at: new Date().toISOString() })
      .eq('id', itemId);
    if (updateErr) {
      console.warn('[api/quotes/:id/apply-color-request] inbox item resolve failed (non-fatal):', updateErr.message);
      return;
    }
    await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'completed', inbox_item_id: itemId, detail: { note: detail } });
  } catch (e) {
    console.warn('[api/quotes/:id/apply-color-request] inbox resolve failed (non-fatal):', e);
  }
}
