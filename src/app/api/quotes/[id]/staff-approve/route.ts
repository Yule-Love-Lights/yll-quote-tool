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
//   - DIFFERENT snapshot: no customer-selection inputs (no packageId /
//     selectedItemIds / colorScheme / etc.) because the operator is approving
//     the quote as-is, not a customer's portal selection. The existing
//     approval_snapshot (if any) is preserved and extended with staffApproved.
//   - NO e-signature (the whole point of this path).
//   - NO GHL/notify calls (the customer already agreed verbally; messaging is
//     the operator's responsibility). is_test quotes are safe: the route never
//     calls any external service.
//
// We deliberately do NOT share a snapshot builder with the customer approve
// route — the two snapshots serve different purposes:
//   - Customer: freezes the customer's portal selection + server-recomputed
//     totals + e-signature. Requires packageId, selectedItemIds, colorSchemeId,
//     etc. — inputs that do not exist in a staff approval.
//   - Staff: freezes a "who approved this and when" audit marker on top of
//     whatever snapshot data already exists (or nothing). No selection inputs.
// Sharing code between them would require making all customer-selection inputs
// optional, which would obscure what each path actually requires and risk
// accidentally omitting them. Keep them separate and self-contained.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { deriveStatus, canTransition, isQuoteStatus } from '@/lib/quoteStatus';
import { getAppSettings } from '@/lib/appSettings';
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
      'id, status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, result, approval_snapshot, is_test, service_type',
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

  // The operator who triggered this (may be null while the auth gate is dormant).
  const operator = await getOperator();
  const approvedAt = new Date().toISOString();

  // #88 P6b-2 — a permanent job still commits the customer to the warranty terms,
  // even on a verbal/phone (staff) approval. Freeze the current warranty copy +
  // version so the booked job records exactly which terms apply, regardless of the
  // approval channel. Non-permanent quotes have no such card → omit it.
  const permanentWarranty =
    quote.service_type === 'permanent' ? (await getAppSettings()).permanentWarranty : null;

  // Build the snapshot: preserve any existing fields (e.g. if the customer had
  // partially filled out a portal form that was never submitted) and add the
  // staffApproved audit marker. This does NOT set customerSelection — there is
  // no customer portal selection for a staff approval.
  const snapshot: Record<string, unknown> = {
    ...(quote.approval_snapshot ?? {}),
    staffApproved: {
      by: operator?.email ?? null,
      at: approvedAt,
    },
    ...(permanentWarranty ? { permanentWarranty } : {}),
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
  // row that just moved to declined/cancelled/lost/changes_requested no longer
  // matches. The OR-with-null idiom mirrors the decline + approve routes.
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({
      status: 'approved',
      customer_approved_at: approvedAt,
      approval_snapshot: snapshot,
    })
    .eq('id', id)
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
