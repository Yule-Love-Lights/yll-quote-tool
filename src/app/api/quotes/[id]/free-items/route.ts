// Post-approval FREE-item selection edit (ledger #162).
//
// POST /api/quotes/[id]/free-items   (operator-only)
// Body:
//   { action: 'add', label: string, quantity?: number }
//   { action: 'remove', portalId: string }
// Response: { ok, action, portalId, label, alreadyPresent?, selectedItemCount } | { error, code? }
//
// Lets staff add or remove a ZERO-DOLLAR line item on an already-approved /
// booked quote (the "free spritzers the customer should have had" case, quote
// #1191). Deliberately SEPARATE from amend (which re-prices + moves money): this
// path only ever touches $0 items, so the order total / deposit / balance are
// invariant. The change rides the same audit trail — a ZERO-delta amendment
// entry is appended (every settlement gate already treats delta 0 as cosmetic:
// requiresReconsent / blocksSettlement both stay false) — and the freeItemEdit
// helpers guarantee the money math can never move (route-asserted below too).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { isMigratedQuote } from '@/lib/quotes';
import { computeAmendment, type AmendmentTrailEntry } from '@/lib/amend';
import { resolveAgreedTotal } from '@/lib/agreedTotal';
import { addFreeLineItem, removeFreeLineItem } from '@/lib/freeItemEdit';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import type { QuoteInputs, QuoteResult } from '@/lib/pricing/pricingEngine';
import { casSwapApprovalSnapshot } from '@/lib/quoteAudit';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CustomerSelection = {
  selectedItemIds?: string[];
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
  inputs: QuoteInputs | null;
  approval_snapshot: {
    customerSelection?: CustomerSelection;
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

  let body: { action?: unknown; label?: unknown; quantity?: unknown; portalId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = body.action;
  if (action !== 'add' && action !== 'remove') {
    return NextResponse.json({ error: "action must be 'add' or 'remove'", code: 'bad-action' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, status, customer_approved_at, deposit_paid_at, deposit_amount_usd, total, result, inputs, approval_snapshot',
    )
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }
  if (!quote.result) {
    return NextResponse.json({ error: 'Quote has no pricing result', code: 'no-result' }, { status: 409 });
  }

  // Row 444: a home.works-migrated order is a record of what a customer agreed
  // and paid, penny-reconciled against their real invoice. This route rewrites
  // inputs.customLineItems, result.lineItems AND
  // approval_snapshot.customerSelection.selectedItemIds — so even though its own
  // total-drift assertion means it cannot move money, it can still rewrite that
  // record. The panel renders on every approved/booked quote, which is all 20 of
  // them, on the same page that shows the Migrated badge. Found by the premerge
  // technical lens after the /api/quote guard shipped: the guard was real but
  // this was a second door into the same rows.
  if (isMigratedQuote(quote.approval_snapshot)) {
    return NextResponse.json(
      {
        error:
          'This order was migrated from home.works. Its line items are a record of what the customer agreed and paid, ' +
          'so they cannot be edited here. To change this order, agree the new figures with Jason and record them directly.',
        code: 'migrated-quote-locked',
      },
      { status: 409 },
    );
  }

  // Only an approved quote has a signed customerSelection to edit.
  const snap = quote.approval_snapshot ?? {};
  const customerSelection = snap.customerSelection;
  if (!quote.customer_approved_at || !customerSelection || !Array.isArray(customerSelection.selectedItemIds)) {
    return NextResponse.json(
      { error: 'Only an approved quote has a selection to edit', code: 'not-approved' },
      { status: 409 },
    );
  }

  // Reject a terminal order (cancelled/declined/abandoned) — mirrors the amend gate.
  const lifecycle = deriveStatus({
    quote_sent_at: null,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    status: quote.status,
  });
  if (lifecycle === 'cancelled' || lifecycle === 'declined' || lifecycle === 'abandoned') {
    return NextResponse.json(
      { error: `Cannot edit a ${lifecycle} order`, code: 'not-editable' },
      { status: 409 },
    );
  }

  const selectedItemIds = customerSelection.selectedItemIds;

  // ── Apply the pure edit ────────────────────────────────────────────────────
  let newInputs: QuoteInputs;
  let newResult: QuoteResult;
  let newSelectedItemIds: string[];
  let affectedPortalId: string;
  let affectedLabel: string;
  let changeKind: 'added' | 'removed';
  let noChange = false;

  if (action === 'add') {
    const label = typeof body.label === 'string' ? body.label : '';
    const quantity = typeof body.quantity === 'number' ? body.quantity : undefined;
    let edit;
    try {
      edit = addFreeLineItem({
        inputs: quote.inputs,
        result: quote.result,
        selectedItemIds,
        label,
        quantity,
        id: crypto.randomUUID(),
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Invalid free item', code: 'bad-item' },
        { status: 400 },
      );
    }
    newInputs = edit.inputs;
    newResult = edit.result;
    newSelectedItemIds = edit.selectedItemIds;
    affectedPortalId = edit.addedPortalId;
    affectedLabel = edit.addedLabel;
    changeKind = 'added';
    // A pure no-op (item already present AND already in the selection) → nothing
    // to persist. Idempotent double-submit lands here.
    noChange =
      edit.alreadyPresent &&
      newSelectedItemIds.length === selectedItemIds.length &&
      newResult.lineItems.length === quote.result.lineItems.length;
  } else {
    const portalId = typeof body.portalId === 'string' ? body.portalId : '';
    let edit;
    try {
      edit = removeFreeLineItem({ inputs: quote.inputs, result: quote.result, selectedItemIds, portalId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Cannot remove item';
      const status = /not found|unknown/i.test(msg) ? 404 : 409;
      return NextResponse.json({ error: msg, code: 'remove-rejected' }, { status });
    }
    newInputs = edit.inputs;
    newResult = edit.result;
    newSelectedItemIds = edit.selectedItemIds;
    affectedPortalId = edit.removedPortalId;
    affectedLabel = edit.removedLabel;
    changeKind = 'removed';
  }

  // Defense-in-depth: the pure helpers only touch $0 lines, but re-assert the
  // money invariant before any write. A drift here is a programmer error.
  if (newResult.total !== quote.result.total) {
    console.error('[api/quotes/:id/free-items] total drift blocked', id, quote.result.total, newResult.total);
    return NextResponse.json({ error: 'Blocked: this edit would change the total', code: 'total-drift' }, { status: 500 });
  }

  if (noChange) {
    return NextResponse.json({
      ok: true,
      action,
      portalId: affectedPortalId,
      label: affectedLabel,
      alreadyPresent: true,
      selectedItemCount: newSelectedItemIds.length,
    });
  }

  // Zero-delta amendment for the audit trail. previousTotal === newTotal (the
  // CURRENT agreed total) → delta 0 → requiresReconsent / blocksSettlement stay
  // false, so this never disturbs the booking or a pending settlement.
  //
  // The agreed total is resolveAgreedTotal (the last amendment's new_total, else
  // the frozen currentTotalUsd, else the result) — NOT the raw currentTotalUsd.
  // If a PRIOR real amend already moved the total, anchoring to currentTotalUsd
  // would make this entry the latest with a stale lower new_total, and
  // resolveAgreedTotal would then feed the next amend/settlement a wrong figure.
  const agreedTotal = resolveAgreedTotal(snap, quote.result);
  const depositPaid = quote.deposit_amount_usd ?? 0;
  const previousBalance = Math.max(0, agreedTotal - depositPaid);
  const op = await getOperator();
  const by = op?.name ? `staff:${op.name}` : op?.email ? `staff:${op.email}` : 'staff';
  let amendment: AmendmentTrailEntry;
  try {
    amendment = computeAmendment({
      previousTotal: agreedTotal,
      depositPaid,
      previousBalance,
      newTotal: agreedTotal,
      by,
      reason: `${changeKind === 'added' ? 'Added' : 'Removed'} free item: ${affectedLabel}`,
      lineItemChanges: [{ id: affectedPortalId, label: affectedLabel, change: changeKind, price: 0 }],
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not record the change' },
      { status: 500 },
    );
  }

  // Concurrency guard: re-read the trail immediately before the write and abort
  // if it grew since our read (mirrors the amend route). The realistic
  // double-submit is already handled by the no-op short-circuit above.
  const { data: fresh } = await sb
    .from('quotes')
    .select('approval_snapshot')
    .eq('id', id)
    .maybeSingle<{ approval_snapshot: { amendments?: AmendmentTrailEntry[]; customerSelection?: CustomerSelection } | null }>();
  const priorAmendments = Array.isArray(snap.amendments) ? snap.amendments : [];
  const freshAmendments = Array.isArray(fresh?.approval_snapshot?.amendments)
    ? fresh!.approval_snapshot!.amendments!
    : [];
  if (freshAmendments.length !== priorAmendments.length) {
    return NextResponse.json(
      { error: 'The order changed while you were editing — please retry.', code: 'concurrent-edit' },
      { status: 409 },
    );
  }

  // Persist: update inputs + result (the $0 line) and the approval_snapshot with
  // the new selection + appended trail entry. The signed original snapshot fields
  // (currentTotalUsd, signature, etc.) are preserved — only selectedItemIds moves.
  const baseSnap = fresh?.approval_snapshot ?? snap;
  const newSnapshot = {
    ...baseSnap,
    customerSelection: {
      ...(baseSnap.customerSelection ?? customerSelection),
      selectedItemIds: newSelectedItemIds,
    },
    amendments: [...freshAmendments, amendment],
  };
  // Atomically bind the line-item/result write to the exact snapshot we read.
  // A financial amend or another free-item edit that wins this race changes the
  // jsonb value, so this stale writer cannot erase its trail or pricing result.
  // Row 411: the CAS write is the shared primitive now — `inputs`/`result`
  // ride as extraColumns in the SAME update, because splitting them from the
  // snapshot write would reopen exactly the race this CAS closes.
  const casOutcome = await casSwapApprovalSnapshot(
    sb,
    id,
    baseSnap as Record<string, unknown>,
    newSnapshot as Record<string, unknown>,
    '[api/quotes/:id/free-items]',
    { inputs: newInputs, result: newResult },
  );
  if (casOutcome === 'error') {
    return NextResponse.json({ error: 'Failed to save the change' }, { status: 500 });
  }
  if (casOutcome === 'conflict') {
    return NextResponse.json(
      { error: 'The order changed while you were editing — please retry.', code: 'concurrent-edit' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    action,
    portalId: affectedPortalId,
    label: affectedLabel,
    alreadyPresent: action === 'add' ? false : undefined,
    selectedItemCount: newSelectedItemIds.length,
  });
}
