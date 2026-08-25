// Operator-triggered quote approval (staff-approve).
//
// POST /api/quotes/[id]/staff-approve   (operator-only)
// Body: none.
// Response: { ok, approved, staff } | { ok, alreadyApproved } | { error, code? }
//
// An operator approves a quote on the customer's behalf — e.g. a verbal or
// phone "yes" — without requiring an e-signature. Advances the quote from
// sent | viewed → approved and freezes a minimal approval_snapshot that
// includes a staffApproved marker (who + when).
//
// Consistency with the customer approve route:
//   - Same status field written: status='approved', customer_approved_at=now
//   - Same atomic guard: .is('customer_approved_at', null)
//   - Same idempotency: already-approved quote → 200 { alreadyApproved:true }
//   - MINIMAL snapshot: no colorScheme / rush / takedown / install-timing
//     inputs (those are a customer's own portal choices, which don't exist
//     for a verbal/phone approval) — but it DOES freeze a customerSelection
//     of { packageId: 'D', selectedItemIds: <every billed line item> }. The
//     operator is approving the quote AS-IS (the whole thing), so "select
//     everything that was billed" is the only honest selection to freeze.
//     (PS-C1/WT-L1 fix: omitting customerSelection entirely made the portal
//     adapter fall back to the holiday-only tier 'C', which doesn't exist on
//     event/bistro/no-back-permanent quotes — computeInitialSelection then
//     found no matching package and rendered a $0 portal, every item OFF.
//     buildPortalLineItems/billableLineItemIds are the SAME functions the
//     portal render itself uses, so the frozen ids always match — including
//     dropping whichever mutually-exclusive roofline option wasn't billed.)
//     The existing approval_snapshot (if any) is preserved and extended with
//     staffApproved + customerSelection.
//   - Row 344: also freezes `pricing: quote.result` (the same field the
//     customer route writes) so the portal's frozen-pricing basis has a
//     snapshot to read here too — a staff-approved quote used to fall
//     straight back to the live, still-changing row.result for every line-
//     item price shown on the portal.
//   - NO e-signature (the whole point of this path).
//   - NO GHL/notify calls (the customer already agreed verbally; messaging is
//     the operator's responsibility). is_test quotes are safe: the route never
//     calls any external service.
//
// We deliberately do NOT share a snapshot builder with the customer approve
// route — the two snapshots serve different purposes:
//   - Customer: freezes the customer's portal selection + server-recomputed
//     totals + e-signature. Requires packageId, selectedItemIds, colorSchemeId,
//     etc. — most of which don't exist in a staff approval.
//   - Staff: freezes a "who approved this and when" audit marker plus the
//     minimal packageId/selectedItemIds pair needed to render a non-empty,
//     correctly-priced portal — never the customer's richer color/fee/timing
//     choices, which a verbal approval simply has none of.
// Sharing code between them would require making all customer-selection inputs
// optional, which would obscure what each path actually requires and risk
// accidentally omitting them. Keep them separate and self-contained.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { deriveStatus, canTransition, isQuoteStatus } from '@/lib/quoteStatus';
import { getAppSettings } from '@/lib/appSettings';
import { buildPortalLineItems, billableLineItemIds } from '@/lib/portal/adapter';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  status: string | null;
  quote_sent_at: string | null;
  viewed_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  result: QuoteResult | null;
  approval_snapshot: Record<string, unknown> | null;
  is_test: boolean;
  // #88 P6b-2 — needed to freeze the warranty version on a permanent staff approval.
  service_type: string | null;
  // View-only portal (#176): a staff-flagged browse-only quote can never be
  // staff-approved either — see the check right after the status gate below.
  view_only: boolean;
};

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote } = await sb
    .from('quotes')
    .select(
      'id, status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, result, approval_snapshot, is_test, service_type, view_only',
    )
    .eq('id', id)
    .maybeSingle<QuoteRow>();

  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // Idempotency: already approved — return without any write.
  if (quote.customer_approved_at) {
    return NextResponse.json({ ok: true, alreadyApproved: true });
  }

  // Gate: only legal transitions are allowed (sent | viewed → approved).
  // Narrow the status string to QuoteStatus for deriveStatus.
  const typedStatus = isQuoteStatus(quote.status) ? quote.status : null;
  const from = deriveStatus({ ...quote, status: typedStatus });
  if (!canTransition(from, 'approved')) {
    return NextResponse.json(
      { error: `Cannot staff-approve from ${from}`, code: 'illegal-transition' },
      { status: 409 },
    );
  }

  // View-only portal (#176): a staff-flagged browse-only quote can never be
  // approved, verbal/phone included — the server hard-guard, mirroring the
  // customer /approve route's check.
  if (quote.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
    );
  }

  // The operator who triggered this (may be null while the auth gate is dormant).
  const operator = await getOperator();
  const approvedAt = new Date().toISOString();

  // #88 P6b-2 — a permanent job still commits the customer to the warranty terms,
  // even on a verbal/phone (staff) approval. Freeze the current warranty copy +
  // version so the booked job records exactly which terms apply, regardless of the
  // approval channel. Non-permanent quotes have no such card → omit it.
  const permanentWarranty =
    quote.service_type === 'permanent' ? (await getAppSettings()).permanentWarranty : null;

  // PS-C1/WT-L1: freeze a minimal customerSelection — the operator approved
  // the quote AS-IS, so the only honest selection is "every line item that
  // was billed" (never a "recommended" subset: any item that subset excluded
  // would silently under-bill the total/deposit on re-render — a money bug).
  // packageId 'D' is required for this to take effect downstream: the portal
  // adapter's resolveApprovalSelectionSeed only honors a non-empty
  // selectedItemIds list when packageId === 'D' (any lettered A/B/C id
  // discards the id list and reseeds from that tier's own bundle instead).
  // buildPortalLineItems/billableLineItemIds are the SAME functions the
  // portal render itself calls, so the ids always match — including dropping
  // whichever mutually-exclusive roofline option (#17 Phase 2) wasn't billed,
  // so a holiday quote never gets both Santa's AND Gingerbread selected.
  const portalLineItems = quote.result ? buildPortalLineItems(quote.result) : null;
  const selectedItemIds = portalLineItems
    ? billableLineItemIds(portalLineItems.lineItems, portalLineItems.roofline)
    : [];

  // Build the snapshot: preserve any existing fields (e.g. if the customer had
  // partially filled out a portal form that was never submitted) and add the
  // staffApproved audit marker + the minimal customerSelection above.
  const snapshot: Record<string, unknown> = {
    ...(quote.approval_snapshot ?? {}),
    staffApproved: {
      by: operator?.email ?? null,
      at: approvedAt,
    },
    ...(selectedItemIds.length > 0
      ? { customerSelection: { packageId: 'D' as const, selectedItemIds } }
      : {}),
    ...(permanentWarranty ? { permanentWarranty } : {}),
    // Row 344 — freeze the full pricing result too, same field the customer
    // /approve route writes (`pricing: quote.result`). Without this the
    // portal adapter's frozen-pricing basis has nothing to read for a
    // staff-approved quote and silently falls back to the live, still-
    // changing row.result — the exact defect this row exists to close. Omit
    // entirely (never null) when quote.result is missing, matching how every
    // other optional snapshot field in this route is written.
    ...(quote.result ? { pricing: quote.result } : {}),
  };

  // Atomic conditional write: .is('customer_approved_at', null) is the
  // concurrency guard. If a concurrent request (customer or another operator)
  // already wrote customer_approved_at, this returns 0 rows and we return
  // alreadyApproved. This ensures the approval is recorded at most once.
  //
  // Bug fix (W1-018): the customer approve route's B2 guard also excludes the
  // branch/terminal statuses in the atomic write, precisely because the fast-path
  // canTransition check is a TOCTOU. staff-approve guarded only on
  // customer_approved_at, so a concurrent customer DECLINE (or request-changes)
  // that lands between the read and this write — which leaves customer_approved_at
  // untouched — was silently overwritten to 'approved', resurrecting a terminal
  // quote. Add the approvable-from status guard (the exact set canTransition allows
  // to 'approved' pre-booking: draft/sent/viewed, plus NULL for legacy rows) so a
  // row that just moved to declined/cancelled/abandoned/changes_requested no longer
  // matches. The OR-with-null idiom mirrors the decline + approve routes.
  //
  // View-only portal (#176 TOCTOU): the early view_only check above is a
  // fast-path 409, but staff could flip view_only ON between that read and
  // this write. `.eq('view_only', false)` makes the write itself lose that
  // race (view_only is NOT NULL, so a plain `.eq` is safe — no W1-014 NULL
  // trap here), mirroring the same re-check on the approve/decline/pay/
  // request-changes/mark-sent routes.
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({
      status: 'approved',
      customer_approved_at: approvedAt,
      approval_snapshot: snapshot,
    })
    .eq('id', id)
    .eq('view_only', false)
    .is('customer_approved_at', null)
    .or('status.in.(draft,sent,viewed),status.is.null')
    .select('id');

  if (error) {
    console.error('[api/quotes/:id/staff-approve] update failed:', error);
    return NextResponse.json({ error: 'Failed to approve the quote' }, { status: 500 });
  }

  // Zero rows updated → a concurrent request moved the quote out from under us.
  // Disambiguate the two causes so the response is truthful (W1-018):
  //   • customer_approved_at now set → a concurrent APPROVE won → idempotent 200.
  //   • otherwise the status moved (decline / request-changes / cancel) → the row
  //     is no longer approvable → 409 already-moved. Never report a resurrected
  //     terminal quote as "approved".
  if (!claimed || claimed.length === 0) {
    const { data: fresh } = await sb
      .from('quotes')
      .select('customer_approved_at')
      .eq('id', id)
      .maybeSingle<{ customer_approved_at: string | null }>();
    if (fresh?.customer_approved_at) {
      return NextResponse.json({ ok: true, alreadyApproved: true });
    }
    return NextResponse.json(
      { error: 'The quote moved to a non-approvable status', code: 'already-moved' },
      { status: 409 },
    );
  }

  // Staff approval recorded. We intentionally do NOT send any GHL/customer
  // notifications here — the operator already has a verbal/phone commitment;
  // they will follow up directly. is_test quotes are safe: no external calls
  // are made in any code path of this route.
  return NextResponse.json({ ok: true, approved: true, staff: true });
}
