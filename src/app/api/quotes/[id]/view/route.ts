// #68 — customer-viewed-quote read receipt.
// Fired client-side (a small useEffect in the portal) when a customer opens
// /portal/[quoteId]. Records the open on the quote row and emails staff (via
// GHL) so they know the quote is being looked at — a warm-lead follow-up signal.
//
// POST /api/quotes/[id]/view
// Body: {} — the quote id is in the URL.
// Response:
//   { ok: true, viewedAt: ISO, viewCount: number }     — recorded
//   { ok: true, skipped: 'not-sent' }                  — quote not yet sent (no-op)
//   { error: string }                                  — on failure
//
// Design notes:
//   * Only counts once the quote has been SENT (quote_sent_at set) — a staff
//     preview of an unsent quote isn't a customer view.
//   * Fired from a client useEffect, so HTML-only bots / link unfurlers (which
//     don't run JS) don't trigger it.
//   * Emails on EVERY open (Naldo's choice) to the internal GHL contact. The DB
//     is stamped first; a GHL failure is non-fatal (never blocks the portal).
//   * Auth model mirrors /send + /approve: the quote UUID is the capability
//     token. Rate-limited to blunt abuse.
//   * #262 — also advances the PERSISTED `status` column sent → viewed (CAS-
//     guarded, see the block below) so a surface reading `status` directly
//     agrees with deriveStatus(). Best-effort/non-fatal — the view itself
//     (viewed_at/view_count) is already the source of truth either way.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  sendEmail,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import {
  internalViewedEmailSubject,
  internalViewedEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isStaffPreview } from '@/lib/auth/staffDevice';
import type { QuoteStatus } from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteRow = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  highlevel_contact_id: string | null;
  // S75 — named in the staff view receipt so a follow-up call knows which
  // vertical it is about without opening the quote.
  service_type: string | null;
  quote_sent_at: string | null;
  viewed_at: string | null;
  view_count: number | null;
  // #262 — the persisted lifecycle status, read so the status-advance block
  // below can CAS it sent → viewed.
  status: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-view', limit: 30, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  // A staff member opening the portal is a STAFF preview, not a customer view —
  // don't notify, count, or log it. Signalled by the staff-device cookie (set on
  // any browser that's visited the operator console) OR a live operator session
  // (#81, once auth is enabled). The cookie is the no-login bridge — the old
  // getOperator()-only check was inert while the auth gate is dormant, so every
  // staff preview counted (S22 fix). Checked first so it touches neither DB nor GHL.
  if (await isStaffPreview(req)) {
    return NextResponse.json({ ok: true, skipped: 'staff' });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, highlevel_contact_id, service_type, quote_sent_at, viewed_at, view_count, status',
    )
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // A view only counts once the quote has actually been sent to the customer —
  // a staff preview of an unsent quote is not a customer open.
  if (!quote.quote_sent_at) {
    return NextResponse.json({ ok: true, skipped: 'not-sent' });
  }

  const now = new Date().toISOString();
  // Non-atomic read-modify-write increment. Acceptable here: opens of a single
  // quote are low-frequency (one customer, occasionally two devices), so the
  // worst case under a true concurrent open is an undercount by one in the
  // staff-email count — cosmetic. An atomic DB-side increment would need an RPC;
  // not worth it for this.
  const viewCount = (quote.view_count ?? 0) + 1;

  // Stamp the DB FIRST so a GHL failure never loses the view. viewed_at is the
  // FIRST open (keep it once set); last_viewed_at + view_count track every open.
  const { error: stampErr } = await sb
    .from('quotes')
    .update({
      viewed_at: quote.viewed_at ?? now,
      last_viewed_at: now,
      view_count: viewCount,
    })
    .eq('id', id);
  if (stampErr) {
    console.error('[api/quotes/:id/view] stamp failed:', stampErr);
    return NextResponse.json({ error: `Failed to record view: ${stampErr.message}` }, { status: 500 });
  }

  // #262 — advance the PERSISTED lifecycle status alongside the receipt above.
  // The stamp above runs unconditionally on every sent quote regardless of its
  // current status (an approved/booked/declined quote still tracks re-opens),
  // but it never touched `status` itself — so a quote sitting at status='sent'
  // with viewed_at set read "Sent" on any surface trusting the persisted
  // column directly instead of deriveStatus(). Advance it ONLY when the row
  // is still exactly 'sent': a CAS write (`.eq('status','sent')` re-asserts on
  // the write the same condition the read above just saw, mirroring the
  // mark-sent/send/invoices.ts idiom) so a concurrent status change between
  // the fetch and this write can't be clobbered, and an approved/booked/
  // declined/already-viewed quote is left byte-untouched. Deliberately a
  // SEPARATE update from the stamp above, not folded in: folding a
  // `.eq('status','sent')` guard onto THAT update would silently stop
  // tracking view_count/last_viewed_at on every quote that isn't still
  // 'sent' — i.e. most repeat views — which must keep working unconditionally.
  // Runs on every non-skipped view (not just the first) so a row that already
  // drifted (status='sent' with viewed_at already set from before this fix
  // shipped) heals the moment it's opened again. Non-fatal on failure — the
  // view itself is already durably recorded above; this is cosmetic reporting
  // drift, not the source of truth (deriveStatus() reads viewed_at correctly
  // either way).
  if (quote.status === 'sent') {
    const { error: statusErr } = await sb
      .from('quotes')
      .update({ status: 'viewed' satisfies QuoteStatus })
      .eq('id', id)
      .eq('status', 'sent');
    if (statusErr) {
      console.warn('[api/quotes/:id/view] status advance failed (non-fatal):', statusErr.message);
    }
  }

  // Append a row to the per-view event log so the customer activity feed can show
  // EVERY open, not just the aggregate above. Best-effort: a failure here (e.g.
  // the quote_view_events table not yet migrated) must not fail the view — the
  // aggregate is already recorded. (Because this is best-effort, the event log
  // and the #68 view_count aggregate can drift apart on a failed insert; the feed
  // is a timeline, not the authoritative count.)
  const { error: eventErr } = await sb
    .from('quote_view_events')
    .insert({ quote_id: id, viewed_at: now });
  if (eventErr) {
    console.warn('[api/quotes/:id/view] event-log insert failed:', eventErr.message);
  }

  // Email staff on every open (#68). Non-fatal — the view is already recorded.
  let emailSent = false;
  let emailError: string | undefined;
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (isHighLevelConfigured() && internalContactId) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const portalUrl = `${baseUrl}/portal/${id}`;
    const adminUrl = `${baseUrl}/quote/${id}`;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    try {
      await sendEmail({
        contactId: internalContactId,
        subject: internalViewedEmailSubject(quote.customer_name),
        html: internalViewedEmailHtml({
          customerName: quote.customer_name,
          address: quote.customer_address,
          phone: quote.customer_phone,
          email: quote.customer_email,
          viewCount,
          portalUrl,
          adminUrl,
          serviceType: quote.service_type,
          // S75 deep links. The location id is the same env var the HighLevel
          // client requires, so it is present whenever isHighLevelConfigured()
          // is true (checked above) — a quote with no linked contact still
          // renders the receipt, just without the two links.
          highlevelContactId: quote.highlevel_contact_id,
          highlevelLocationId: process.env.HIGHLEVEL_LOCATION_ID ?? null,
        }),
        emailFrom,
      });
      emailSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/view] staff email failed:', hlErrorMessage(err));
      emailError = hlErrorMessage(err);
    }
  }

  return NextResponse.json({ ok: true, viewedAt: quote.viewed_at ?? now, viewCount, emailSent, emailError });
}
