// Operator-triggered quote decline (staff-decline).
//
// POST /api/quotes/[id]/staff-decline   (operator-only)
// Body: { reason?: string }   — optional, trimmed, ≤2000 chars
// Response: { ok, status:'declined', staff:true } | { ok, alreadyDeclined:true } | { error, code? }
//
// An operator records that the CUSTOMER declined outside the tool — e.g. a "no
// thanks" by phone or text, not through the portal decline flow. It is the staff
// mirror of the customer /decline route, and follows the /staff-approve pattern:
//   - operator-only (requireOperator), unlike the customer /decline route which
//     is authed by the quote-UUID capability token.
//   - Same status field + reason column written as the customer decline:
//     status='declined', decline_reason=<reason or a staff marker>.
//   - Same legal-transition gate: canTransition(from, 'declined') — declinable
//     only from {sent, viewed, changes_requested} (NOT approved/booked/terminal),
//     derived from the canonical table so it can never drift from quoteStatus.ts.
//   - Same guarded write as the customer decline route (.or(declinable).is(
//     deposit_paid_at, null)) so a concurrent approval/booking can't be raced past.
//   - Audit marker, mirroring staff-approve's approval_snapshot.staffApproved:
//     approval_snapshot.staffDeclined = { by, at, reason }. No new column.
//   - Idempotent: an already-declined quote → 200 { alreadyDeclined:true }.
//   - NO GHL/notify calls: the customer already told the operator directly; the
//     operator handles any follow-up. is_test quotes are safe (no external calls).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import {
  canTransition,
  deriveStatus,
  isQuoteStatus,
  QUOTE_STATUSES,
  type QuoteStatus,
} from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 2000;

// The statuses a decline is legal FROM — derived once from the canonical
// transition table so this route can never drift from quoteStatus.ts. Used both
// to short-circuit (current status) and to GUARD the DB write (.or(...)).
const DECLINABLE_FROM: QuoteStatus[] = QUOTE_STATUSES.filter((s) => canTransition(s, 'declined'));

type QuoteRow = {
  id: string;
  status: string | null;
  quote_sent_at: string | null;
  viewed_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  approval_snapshot: Record<string, unknown> | null;
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

  // Reason is OPTIONAL for a staff decline (a missing/empty body is fine) — a
  // default marker is stored when none is given. A malformed JSON body is
  // tolerated the same way (treated as no reason) rather than 400'd.
  let reason = '';
  try {
    const body = (await req.json()) as { reason?: unknown };
    if (body && typeof body.reason === 'string') reason = body.reason.trim();
  } catch {
    /* no/invalid body → empty reason */
  }
  if (reason.length > REASON_MAX) {
    return NextResponse.json(
      { error: `Reason must be ${REASON_MAX} characters or fewer`, code: 'reason-too-long' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote } = await sb
    .from('quotes')
    .select(
      'id, status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, approval_snapshot',
    )
    .eq('id', id)
    .maybeSingle<QuoteRow>();

  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // Narrow the persisted status string, then derive the current state.
  const typedStatus = isQuoteStatus(quote.status) ? quote.status : null;
  const from = deriveStatus({ ...quote, status: typedStatus });

  // Idempotency: already declined — return without any write (mirrors
  // staff-approve's alreadyApproved).
  if (from === 'declined') {
    return NextResponse.json({ ok: true, alreadyDeclined: true });
  }

  // Gate: only legal transitions (sent | viewed | changes_requested → declined).
  if (!canTransition(from, 'declined')) {
    return NextResponse.json(
      { error: `Cannot mark declined from ${from}`, code: 'illegal-transition' },
      { status: 409 },
    );
  }

  const operator = await getOperator();
  const declinedAt = new Date().toISOString();
  // Human-visible reason the admin list already renders; default to a staff
  // marker when the operator didn't type one.
  const storedReason = reason || 'Declined outside the tool (recorded by staff).';
  // Audit marker, mirroring staff-approve. Preserves any existing snapshot.
  const snapshot: Record<string, unknown> = {
    ...(quote.approval_snapshot ?? {}),
    staffDeclined: {
      by: operator?.email ?? null,
      at: declinedAt,
      reason: reason || null,
    },
  };

  // Guarded write — only a row still eligible to decline is updated, so a
  // concurrent approval/booking that landed between the SELECT and here can't be
  // raced past. Eligible = (persisted status in the declinable set) OR (status IS
  // NULL — a legacy/pre-migration row the fast path already cleared via its
  // timestamps), AND the deposit hasn't been paid. Zero rows ⇒ we lost the race.
  const declinableFilter = `status.in.(${DECLINABLE_FROM.join(',')}),status.is.null`;
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({
      status: 'declined' satisfies QuoteStatus,
      decline_reason: storedReason,
      approval_snapshot: snapshot,
    })
    .eq('id', id)
    .or(declinableFilter)
    .is('deposit_paid_at', null)
    .select('id');

  if (error) {
    console.error('[api/quotes/:id/staff-decline] update failed:', error);
    return NextResponse.json({ error: 'Failed to record the decline' }, { status: 500 });
  }

  // Race loser: the row moved out of a declinable status between read and write.
  if (!claimed || claimed.length === 0) {
    return NextResponse.json(
      { error: 'Cannot mark this quote declined anymore', code: 'invalid-status' },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, status: 'declined', staff: true });
}
