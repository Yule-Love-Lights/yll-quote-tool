// Customer-triggered "request changes" (#83 Phase 1, Slice B).
// Called when the customer clicks "Request changes" on the portal and leaves a
// note. The quote returns to staff (status: changes_requested) so they can edit
// and re-send it.
//
// POST /api/quotes/[id]/request-changes
// Body: { note: string }   — required, trimmed, ≤2000 chars
// Response:
//   { ok: true, status: 'changes_requested' }
//   { error: string, code?: string }
//
// Auth model: same as /approve, /send, /decline — the quote UUID is the
// capability token (a customer portal action). Rate-limited.
//
// Status gate: changes are requestable only from the states quoteStatus.ts
// marks as transitionable to 'changes_requested'. Per Slice A's table that is
// {sent, viewed} — NOT approved (already signed), NOT booked/terminal, and NOT
// changes_requested again (no double-request). We gate on the fast-path
// deriveStatus + canTransition, then GUARD the write on the same set (plus a
// NULL-status legacy escape + deposit-unpaid) so a concurrent approval/booking
// can't be raced past.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { sendEmail, isHighLevelConfigured, HighLevelError } from '@/lib/integrations/highlevel';
import {
  internalChangesRequestedEmailSubject,
  internalChangesRequestedEmailHtml,
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
const NOTE_MAX = 2000;

// States a change-request is legal FROM — derived once from the canonical
// transition table so this route can't drift from quoteStatus.ts.
const CHANGES_FROM: QuoteStatus[] = QUOTE_STATUSES.filter((s) =>
  canTransition(s, 'changes_requested'),
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

  const rl = rateLimitResponse(req, { bucket: 'quote-request-changes', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) {
    return NextResponse.json({ error: 'A note is required', code: 'note-required' }, { status: 400 });
  }
  if (note.length > NOTE_MAX) {
    return NextResponse.json(
      { error: `Note must be ${NOTE_MAX} characters or fewer`, code: 'note-too-long' },
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

  const current = deriveStatus(quote);
  if (!canTransition(current, 'changes_requested')) {
    return NextResponse.json(
      { error: `Cannot request changes on a quote that is ${current}`, code: 'invalid-status' },
      { status: 409 },
    );
  }

  // Guarded write — only a row still eligible is updated (persisted status in
  // the change-requestable set OR a NULL-status legacy row the fast path
  // cleared) AND not yet paid, so a concurrent approval/booking can't be raced
  // past. Zero rows ⇒ we lost ⇒ 409.
  const changesFilter = `status.in.(${CHANGES_FROM.join(',')}),status.is.null`;
  const { data: updatedRows, error: updErr } = await sb
    .from('quotes')
    .update({ status: 'changes_requested' satisfies QuoteStatus })
    .eq('id', id)
    .or(changesFilter)
    .is('deposit_paid_at', null)
    .select('id');

  if (updErr) {
    console.error('[api/quotes/:id/request-changes] update failed:', updErr);
    return NextResponse.json(
      { error: `Failed to record the request: ${updErr.message}` },
      { status: 500 },
    );
  }
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json(
      { error: 'Cannot request changes on this quote anymore', code: 'invalid-status' },
      { status: 409 },
    );
  }

  // Best-effort staff notification so staff know to edit + resend.
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (isHighLevelConfigured() && internalContactId) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    try {
      await sendEmail({
        contactId: internalContactId,
        subject: internalChangesRequestedEmailSubject(quote.customer_name),
        html: internalChangesRequestedEmailHtml({
          customerName: quote.customer_name,
          address: quote.customer_address,
          phone: quote.customer_phone,
          email: quote.customer_email,
          note,
          portalUrl: `${baseUrl}/portal/${id}`,
          adminUrl: `${baseUrl}/quote/${id}`,
        }),
        emailFrom,
      });
    } catch (err) {
      console.warn('[api/quotes/:id/request-changes] staff email failed:', hlErrorMessage(err));
    }
  }

  return NextResponse.json({ ok: true, status: 'changes_requested' });
}
