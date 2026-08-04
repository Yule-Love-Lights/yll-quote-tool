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
//   - NO customer notify calls: the customer already told the operator directly;
//     the operator handles any follow-up. is_test quotes are safe (no external
//     calls). It DOES move the linked GHL opportunity card (if any) to the
//     Declined stage for the quote's service type — same best-effort, never-
//     creates-a-card, fail-open pattern as the customer /decline route.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import {
  updateOpportunity,
  findOpportunityForContact,
  upsertContactCustomField,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { resolvePipelineStages, quoteLinkFieldId } from '@/lib/integrations/ghlPipelineMap';
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

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteRow = {
  id: string;
  status: string | null;
  quote_sent_at: string | null;
  viewed_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  approval_snapshot: Record<string, unknown> | null;
  // GHL card-move (#GHL pipeline sync): which pipeline the card lives in, the
  // linked card (if any), and the Test Quote guard (#93).
  highlevel_contact_id: string | null;
  highlevel_opportunity_id: string | null;
  service_type: string | null;
  is_test: boolean;
  // Legacy rebook (#156): routes to the Neighbors pipeline instead of the
  // service_type's own map — see resolvePipelineStages.
  legacy_rebook: boolean;
  // View-only portal (#176): a staff-flagged browse-only quote can never be
  // staff-declined either — see the check right after the status gate below.
  view_only: boolean;
};

// Best-effort: move the quote's linked HighLevel opportunity to the Declined
// stage for its service type, then (independent of whether the move
// succeeded) blank the per-service-type quote-link contact custom field so a
// declined quote's link stops feeding that pipeline's drip automations. NEVER
// creates a card (only moves one that already exists), and NEVER fails the
// decline.
async function moveDeclinedOpportunity(quote: QuoteRow, id: string): Promise<void> {
  if (quote.is_test || !isHighLevelConfigured()) return;

  try {
    const stages = resolvePipelineStages(quote.service_type, { legacyRebook: quote.legacy_rebook });
    let opportunityId = quote.highlevel_opportunity_id;
    if (!opportunityId && quote.highlevel_contact_id) {
      const existing = await findOpportunityForContact(quote.highlevel_contact_id, stages.pipelineId);
      opportunityId = existing?.id ?? null;
    }
    if (opportunityId) {
      await updateOpportunity(opportunityId, { pipelineStageId: stages.declined });
    } // else: no card to move — never create one on decline
  } catch (err) {
    console.error(`[api/quotes/:id/staff-decline] GHL decline stage move failed for quote ${id}:`, hlErrorMessage(err));
  }

  // Clear the quote-link field even if the card move above failed or found no
  // card — the field can be stamped while the linked opportunity id is stale,
  // so the two are attempted independently.
  if (quote.highlevel_contact_id) {
    const fieldId = quoteLinkFieldId(quote.service_type, { legacyRebook: quote.legacy_rebook });
    if (fieldId) {
      try {
        await upsertContactCustomField(quote.highlevel_contact_id, fieldId, '');
      } catch (err) {
        console.error(`[api/quotes/:id/staff-decline] quote-link custom field clear failed for quote ${id}:`, hlErrorMessage(err));
      }
    }
  }
}

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
      'id, status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, approval_snapshot, highlevel_contact_id, highlevel_opportunity_id, service_type, is_test, legacy_rebook, view_only',
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

  // View-only portal (#176): a staff-flagged browse-only quote can never be
  // staff-declined either — the server hard-guard, mirroring staff-approve's
  // check (and the customer /decline route's).
  if (quote.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
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
  //
  // View-only portal (#176 TOCTOU): the early view_only check above is a
  // fast-path 409, but staff could flip view_only ON between that read and
  // this write. `.eq('view_only', false)` makes the write itself lose that
  // race (view_only is NOT NULL, so a plain `.eq` is safe — no W1-014 NULL
  // trap here), mirroring the same re-check on staff-approve/decline/approve/
  // pay/request-changes/mark-sent.
  const declinableFilter = `status.in.(${DECLINABLE_FROM.join(',')}),status.is.null`;
  const { data: claimed, error } = await sb
    .from('quotes')
    .update({
      status: 'declined' satisfies QuoteStatus,
      decline_reason: storedReason,
      approval_snapshot: snapshot,
    })
    .eq('id', id)
    .eq('view_only', false)
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

  // Best-effort: move the linked GHL card (if any) to the Declined stage for
  // this quote's service type. Never fails the decline.
  await moveDeclinedOpportunity(quote, id);

  return NextResponse.json({ ok: true, status: 'declined', staff: true });
}
