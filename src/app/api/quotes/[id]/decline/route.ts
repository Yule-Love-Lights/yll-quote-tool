// Customer-triggered quote decline (#83 Phase 1, Slice B).
// Called when the customer clicks "Decline" on the portal and gives a reason.
//
// POST /api/quotes/[id]/decline
// Body: { reason: string }   — required, trimmed, ≤2000 chars
// Response:
//   { ok: true, status: 'declined' }
//   { error: string, code?: string }
//
// Auth model: same as /approve and /send — the quote UUID (a 128-bit random
// token) is the capability token. This is a customer portal action: if you
// hold the link, you can decline. Rate-limited to stop endpoint spam.
//
// Status gate: a quote is declinable only from the states quoteStatus.ts marks
// as transitionable to 'declined'. We derive the current status from the row
// (deriveStatus — explicit `status` wins for branch states, else timestamps)
// and require canTransition(current → 'declined'). Per Slice A's table that is
// {sent, viewed, changes_requested} — NOT approved (a signed/approved quote is
// deliberately non-declinable; the signature attests to the agreement) and NOT
// booked/terminal. A non-declinable quote is refused 409. The DB write itself
// is GUARDED so a concurrent approval/booking can't be raced past: it only
// matches a row whose persisted status is still in the declinable set OR whose
// status is NULL (a pre-migration row that the fast-path already cleared via its
// timestamps) AND that hasn't been paid (deposit_paid_at IS NULL). Zero rows
// updated ⇒ we lost the race ⇒ 409.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { sendEmail, isHighLevelConfigured, HighLevelError } from '@/lib/integrations/highlevel';
import {
  internalDeclineEmailSubject,
  internalDeclineEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  canTransition,
  deriveStatus,
  QUOTE_STATUSES,
  type QuoteStatus,
  type QuoteStatusRow,
} from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 2000;

// The statuses a CUSTOMER-initiated decline (this portal route) is legal FROM.
// #124 widened the state machine so draft + approved → declined are legal too, but
// those are OPERATOR-only (the /staff-decline route): a customer never self-declines
// a draft they were never sent, nor un-approves a quote they already signed. So this
// route keeps its original narrower set — derived from the canonical table (so
// booked/terminal stay excluded automatically) MINUS the #124 staff-only additions.
// Used both to short-circuit (current status) and to GUARD the DB write (.in(...)).
const CUSTOMER_DECLINABLE_FROM: QuoteStatus[] = QUOTE_STATUSES.filter(
  (s) => canTransition(s, 'declined') && s !== 'draft' && s !== 'approved',
);

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteRow = QuoteStatusRow & {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  highlevel_contact_id: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-decline', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required', code: 'reason-required' }, { status: 400 });
  }
  if (reason.length > REASON_MAX) {
    return NextResponse.json(
      { error: `Reason must be ${REASON_MAX} characters or fewer`, code: 'reason-too-long' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, highlevel_contact_id, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, status',
    )
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Status gate (fast path). deriveStatus prefers an explicit branch status and
  // otherwise reads the timestamps. A booked/terminal quote can't be declined.
  const current = deriveStatus(quote);
  if (!CUSTOMER_DECLINABLE_FROM.includes(current)) {
    return NextResponse.json(
      { error: `Cannot decline a quote that is ${current}`, code: 'invalid-status' },
      { status: 409 },
    );
  }

  // Guarded write — only a row still eligible to decline is updated, so a
  // concurrent approval/booking that landed between the SELECT and here can't be
  // raced past. Eligible = (persisted status in the declinable set) OR (status
  // IS NULL — a legacy/pre-migration row the fast path already cleared via its
  // timestamps), AND the deposit hasn't been paid (booking is the one race that
  // can flip a still-"sent"/NULL row out from under us). `.select('id')` returns
  // the affected rows; zero rows ⇒ we lost the race ⇒ 409.
  const declinableFilter = `status.in.(${CUSTOMER_DECLINABLE_FROM.join(',')}),status.is.null`;
  const { data: updatedRows, error: updErr } = await sb
    .from('quotes')
    .update({ status: 'declined' satisfies QuoteStatus, decline_reason: reason })
    .eq('id', id)
    .or(declinableFilter)
    .is('deposit_paid_at', null)
    .select('id');

  if (updErr) {
    console.error('[api/quotes/:id/decline] update failed:', updErr);
    return NextResponse.json({ error: `Failed to record decline: ${updErr.message}` }, { status: 500 });
  }
  if (!updatedRows || updatedRows.length === 0) {
    // The row moved out of a declinable status between our read and write.
    return NextResponse.json(
      { error: 'Cannot decline this quote anymore', code: 'invalid-status' },
      { status: 409 },
    );
  }

  // Best-effort staff notification — a messaging hiccup must never undo the
  // recorded decline.
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (isHighLevelConfigured() && internalContactId) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    try {
      await sendEmail({
        contactId: internalContactId,
        subject: internalDeclineEmailSubject(quote.customer_name),
        html: internalDeclineEmailHtml({
          customerName: quote.customer_name,
          address: quote.customer_address,
          phone: quote.customer_phone,
          email: quote.customer_email,
          reason,
          portalUrl: `${baseUrl}/portal/${id}`,
          adminUrl: `${baseUrl}/quote/${id}`,
        }),
        emailFrom,
      });
    } catch (err) {
      console.warn('[api/quotes/:id/decline] staff email failed:', hlErrorMessage(err));
    }
  }

  return NextResponse.json({ ok: true, status: 'declined' });
}
