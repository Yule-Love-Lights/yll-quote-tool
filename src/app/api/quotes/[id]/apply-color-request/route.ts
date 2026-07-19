// Staff APPLY / DISMISS a pending customer colour-change request (ledger #163
// Slice B). Operator-gated.
//
// POST /api/quotes/[id]/apply-color-request
// Body: { action: 'apply' } | { action: 'dismiss', reason: string }
// Response: { ok, action, label? } | { error, code? }
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
} from '@/lib/design/colorSchemes';
import { resolveColorChoice } from '@/lib/inventory/resolveInstalls';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

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
      'id, status, customer_approved_at, deposit_paid_at, deposit_amount_usd, total, result, service_type, approval_snapshot',
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

  // Reject a terminal order (mirrors the amend / free-items gates).
  const lifecycle = deriveStatus({
    quote_sent_at: null,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    status: quote.status,
  });
  if (lifecycle === 'cancelled' || lifecycle === 'declined' || lifecycle === 'lost') {
    return NextResponse.json({ error: `Cannot act on a ${lifecycle} order`, code: 'not-editable' }, { status: 409 });
  }

  const op = await getOperator();
  const by = op?.name ? `staff:${op.name}` : op?.email ? `staff:${op.email}` : 'staff';

  // ── DISMISS ────────────────────────────────────────────────────────────────
  if (action === 'dismiss') {
    const { pendingColorRequest: _dropped, ...restSnap } = snap;
    void _dropped;
    const { error: upErr } = await sb.from('quotes').update({ approval_snapshot: restSnap }).eq('id', id);
    if (upErr) {
      console.error('[api/quotes/:id/apply-color-request] dismiss save failed:', upErr);
      return NextResponse.json({ error: 'Could not dismiss the request' }, { status: 500 });
    }
    await resolveInboxRequest(sb, id, by, `Dismissed colour change: ${reason}`);
    return NextResponse.json({ ok: true, action: 'dismiss' });
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
  const label = typeof pending.label === 'string' && pending.label ? pending.label : colorSchemeId;

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

  // Concurrency guard on the auditable trail (mirrors the amend / free-items routes).
  const priorAmendments = Array.isArray(snap.amendments) ? snap.amendments : [];
  const { data: fresh } = await sb
    .from('quotes')
    .select('approval_snapshot')
    .eq('id', id)
    .maybeSingle<{ approval_snapshot: { amendments?: AmendmentTrailEntry[]; customerSelection?: CustomerSelection; pendingColorRequest?: PendingColorRequest } | null }>();
  const freshSnap = fresh?.approval_snapshot ?? snap;
  const freshAmendments = Array.isArray(freshSnap.amendments) ? freshSnap.amendments : [];
  if (freshAmendments.length !== priorAmendments.length) {
    return NextResponse.json({ error: 'The order changed while you were applying — please retry.', code: 'concurrent-edit' }, { status: 409 });
  }
  // Idempotency: the request was applied/dismissed out from under us.
  if (!freshSnap.pendingColorRequest) {
    return NextResponse.json({ error: 'No pending colour request', code: 'nothing-pending' }, { status: 409 });
  }

  // Persist: re-freeze the colour into customerSelection, drop pendingColorRequest,
  // append the trail entry. Total / deposit / balance are untouched.
  const { pendingColorRequest: _drop, ...restFreshSnap } = freshSnap;
  void _drop;
  const newSnapshot = {
    ...restFreshSnap,
    customerSelection: {
      ...(freshSnap.customerSelection ?? customerSelection),
      colorSchemeId,
      customPattern,
      colorIds,
    },
    amendments: [...freshAmendments, amendment],
  };
  const { error: upErr } = await sb.from('quotes').update({ approval_snapshot: newSnapshot }).eq('id', id);
  if (upErr) {
    console.error('[api/quotes/:id/apply-color-request] apply save failed:', upErr);
    return NextResponse.json({ error: 'Could not apply the colour change' }, { status: 500 });
  }
  await resolveInboxRequest(sb, id, by, `Applied colour change: ${label}`);

  return NextResponse.json({ ok: true, action: 'apply', label });
}

/** Best-effort: mark the Slice-A inbox notification (quotetool / <id>:color-request)
 *  handled so it clears from the operator queue. Never fails the request. */
async function resolveInboxRequest(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  quoteId: string,
  operatorId: string,
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
    await sb
      .from('inbox_items')
      .update({ status: 'completed', handled_by: operatorId, handled_at: new Date().toISOString() })
      .eq('id', itemId);
    await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'completed', inbox_item_id: itemId, detail: { note: detail } });
  } catch (e) {
    console.warn('[api/quotes/:id/apply-color-request] inbox resolve failed (non-fatal):', e);
  }
}
