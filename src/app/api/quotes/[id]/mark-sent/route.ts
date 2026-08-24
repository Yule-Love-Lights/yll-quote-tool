// Manual "Mark as sent" — DB-only (ledger #182).
//
// POST /api/quotes/[id]/mark-sent   (operator-only)
// Body: none.
// Response:
//   { ok: true, status: 'sent', sentAt }
//   { error: string, code?: string }
//
// Staff sometimes deliver a quote OUTSIDE the tool (hand-texting the portal
// link, walking through it on a call) — the real /send route is never
// called, so the quote sits 'draft' forever with quote_sent_at null and the
// wrong status everywhere (admin list, dashboard, pipeline actions). This
// route lets an operator stamp the SAME DB end-state a real send produces —
// quote_sent_at = now, status = 'sent' — with NO messaging and NO GHL side
// effects of any kind. It never texts/emails the customer and never
// creates/moves a HighLevel opportunity card; staff who used this route are
// expected to have already handed the link off themselves.
//
// Status gate: legal only from a state canTransition(_, 'sent') allows —
// derived from quoteStatus.ts so this can never drift from the canonical
// table. In practice that's 'draft' (a quote that was never sent) and
// 'changes_requested' (draft's still-in-the-set companion), though the
// latter is moot here: reaching changes_requested requires having been sent
// once already, so it always has quote_sent_at set and is caught by the
// already-sent guard below first. An approved/booked/declined/cancelled/abandoned
// quote can never be "re-marked sent" — 409 illegal-transition.
//
// Idempotency + race safety: quote_sent_at set at read time → 409
// already-sent. The write itself is additionally guarded
// (.is('quote_sent_at', null), the view_only re-check, and the same
// status-in-set-or-null clause the staff-approve/staff-decline routes use)
// so a concurrent send/staff-approve/staff-decline/view-only-toggle landing
// in the gap between our read and write can't be raced past — zero rows
// updated is reported as the same 409.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import {
  canTransition,
  deriveStatus,
  isQuoteStatus,
  QUOTE_STATUSES,
  type QuoteStatus,
} from '@/lib/quoteStatus';
import { attachQuoteToCustomer, propagateQuoteTagsToCustomer, quoteRowToIdentity } from '@/lib/customers';
import { queueQuoteBuildSessionCompletion } from '@/lib/quoteBuildTiming';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The statuses this manual mark is legal FROM — derived once from the
// canonical transition table so it can never drift from quoteStatus.ts. Used
// both to short-circuit (current status) and to GUARD the DB write (.or(...)).
const MARK_SENT_FROM: QuoteStatus[] = QUOTE_STATUSES.filter((s) => canTransition(s, 'sent'));

type QuoteRow = {
  id: string;
  status: string | null;
  quote_sent_at: string | null;
  viewed_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  view_only: boolean;
  // NCE + YLL Neighbor tag propagation (#198) — see the sibling /send route's
  // doc comment for the full rationale (same pattern, this is the OTHER
  // become-sent writer the ledger names).
  legacy_rebook: boolean;
  is_nce: boolean;
  // Test Quote (ledger #93) — review fix (admin HIGH, S34 #198 review): a
  // tagged TEST mark-sent must never touch attachQuoteToCustomer/
  // propagateQuoteTagsToCustomer with test data (same rationale as /send).
  is_test: boolean;
  customer_id: string | null;
  highlevel_contact_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
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
      'id, status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, view_only, legacy_rebook, is_nce, customer_id, highlevel_contact_id, customer_name, customer_email, customer_phone, customer_address, is_test',
    )
    .eq('id', id)
    .maybeSingle<QuoteRow>();

  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // View-only portal (#176): a staff-flagged browse-only quote can never be
  // marked sent either — mirrors the real /send route's guard.
  if (quote.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
    );
  }

  // Idempotency (fast path): already sent — refuse rather than silently no-op,
  // per the ledger spec (repeat call on an already-marked quote → 409).
  if (quote.quote_sent_at) {
    return NextResponse.json(
      { error: 'This quote has already been sent', code: 'already-sent', sentAt: quote.quote_sent_at },
      { status: 409 },
    );
  }

  // Status gate: only a legal transition to 'sent' is allowed (e.g. an
  // approved/declined/booked/terminal quote can't be re-marked sent).
  const typedStatus = isQuoteStatus(quote.status) ? quote.status : null;
  const current = deriveStatus({ ...quote, status: typedStatus });
  if (!canTransition(current, 'sent')) {
    return NextResponse.json(
      { error: `Cannot mark sent from ${current}`, code: 'illegal-transition' },
      { status: 409 },
    );
  }

  const sentAt = new Date().toISOString();

  // Guarded write — same DB end-state a real send stamps on a fresh send
  // (quote_sent_at + status='sent'), minus any messaging/GHL work. Guarded on
  // quote_sent_at IS NULL (the idempotency/CAS key) + view_only false (TOCTOU
  // re-check) + the status-in-the-legal-set-or-null clause (mirrors the
  // staff-approve/staff-decline idiom) so a concurrent send/approve/decline/
  // view-only-toggle landing between our read and this write can't be raced
  // past — zero rows updated reports the same 409 below.
  const markableFilter = `status.in.(${MARK_SENT_FROM.join(',')}),status.is.null`;
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({ quote_sent_at: sentAt, status: 'sent' satisfies QuoteStatus })
    .eq('id', id)
    .eq('view_only', false)
    .is('quote_sent_at', null)
    .or(markableFilter)
    .select('id');

  if (error) {
    console.error('[api/quotes/:id/mark-sent] update failed:', error);
    return NextResponse.json({ error: 'Failed to mark the quote sent' }, { status: 500 });
  }

  // Race loser: the row moved out from under us between read and write.
  if (!claimed || claimed.length === 0) {
    return NextResponse.json(
      { error: 'Cannot mark this quote sent anymore', code: 'invalid-status' },
      { status: 409 },
    );
  }

  if (!quote.is_test) {
    queueQuoteBuildSessionCompletion({ quoteId: id, timerId: null, sentAt });
  }

  // NCE + YLL Neighbor tag propagation (#198) — mirrors the real /send
  // route's block exactly (this route stamps the SAME become-sent DB
  // end-state, just without messaging/GHL). Skipped entirely for an untagged
  // quote (the common case). !quote.is_test is REQUIRED — see /send's
  // sibling comment for the full rationale.
  //
  // #214 (verify-or-reattach): attach-first, cached-id fallback — see the
  // /send route's sibling comment for the full rationale (the cached
  // customer_id can be stale after an identity edit; re-resolution is
  // idempotent and quoteRowToIdentity keeps the row's display sentinels out
  // of the identity).
  if (!quote.is_test && (quote.legacy_rebook || quote.is_nce)) {
    try {
      const resolved = await attachQuoteToCustomer(
        quoteRowToIdentity({
          id,
          highlevel_contact_id: quote.highlevel_contact_id,
          customer_name: quote.customer_name,
          customer_email: quote.customer_email,
          customer_phone: quote.customer_phone,
          customer_address: quote.customer_address,
        }),
      );
      // Repoint visibility (#214 review, WT-55 family) — mirrors /send.
      if (resolved && quote.customer_id && resolved.customerId !== quote.customer_id) {
        console.warn(
          `[api/quotes/:id/mark-sent] #214 repoint: quote ${id} customer_id ${quote.customer_id} → ${resolved.customerId} at mark-sent. Review for a manual merge (WT-55).`,
        );
      }
      const linkedCustomerId = resolved?.customerId ?? quote.customer_id ?? null;
      if (linkedCustomerId) {
        await propagateQuoteTagsToCustomer(linkedCustomerId, {
          isNce: quote.is_nce,
          isYllNeighbor: quote.legacy_rebook,
        });
      }
    } catch (err) {
      console.warn('[api/quotes/:id/mark-sent] tag propagation failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, status: 'sent', sentAt });
}
