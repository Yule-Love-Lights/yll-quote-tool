// Customer-triggered "reopen my quote" ask (ledger row 236).
//
// POST /api/quotes/[id]/reopen-request
// Body: none required.
// Response:
//   { ok: true }                       — request received (email sent or best-effort attempted)
//   { ok: true, skipped: 'staff' }     — a staff preview, never a customer ask (see below)
//   { ok: true, skipped: 'cooldown' }  — a request for this quote already fired recently
//   { error: string, code?: string }
//
// Auth model: same as the other customer quote sub-routes (/approve, /decline,
// /request-changes) — the quote UUID is the capability token. Rate-limited.
//
// A DECLINED or ABANDONED quote's portal stays browsable (colors, line-item
// toggles) but the approve/pay/decline/request-changes actions are all closed
// (see StickyBottomBar's terminalBrowse branch + each of those routes' own
// status guards). This is the one action left: "Want to reopen your quote?
// Let us know!" — it does NOT change the quote's status or revive it (that's
// canRevive + the staff /send route, an operator decision); it just tells
// staff the customer is interested again. Modeled on request-changes/route.ts's
// internal-email pattern (sendEmail to HIGHLEVEL_INTERNAL_CONTACT_ID + an
// internal HTML builder) — no DB write, no GHL card move, no customer-typed
// note (the affordance is a single button).
//
// Eligible FROM exactly {declined, abandoned} — canRevive(current) is the
// canonical definition of "a dead quote that can still be revived" already
// used by the staff /send route, so this can never drift from that set.
//
// Fix round (four-lens, MED): row 236's browse mode means a staff member can
// open a terminal quote's portal and the reopen button is the ONLY CTA there
// — so a staff preview click needs the SAME isStaffPreview skip its siblings
// view/route.ts and interested/route.ts already have, or a staff click fires
// a real internal email indistinguishable from a genuine customer ask.
// Checked BEFORE any DB work (mirrors view/route.ts's ordering) AND before
// the cooldown claim below — a staff click must not burn the customer's
// 1-hour cooldown slot either.
//
// Idempotent-ish (not a DB-backed dedupe): a per-quote in-memory cooldown
// (mirrors referral request-link's sendAndStamp — checkRateLimitByKey keyed
// on the quote id, limit 1 per window) stops a customer mashing the button
// from spamming staff with duplicate emails. Released on a thrown send so a
// legit retry after a transient HighLevel failure isn't locked out for the
// rest of the window having received nothing.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse, checkRateLimitByKey, releaseRateLimitByKey } from '@/lib/rateLimit';
import { sendEmail, isHighLevelConfigured, HighLevelError } from '@/lib/integrations/highlevel';
import {
  internalReopenRequestedEmailSubject,
  internalReopenRequestedEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isStaffPreview } from '@/lib/auth/staffDevice';
import { canRevive, deriveStatus, type QuoteStatusRow } from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors referral request-link's EMAIL_SEND_COOLDOWN_MS (1 hour) — the
// closest existing "don't spam staff with repeat clicks" idiom in this repo.
const REOPEN_REQUEST_COOLDOWN_MS = 60 * 60 * 1000;

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteRow = QuoteStatusRow & {
  id: string;
  quote_number: number | null;
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

  const rl = rateLimitResponse(req, { bucket: 'quote-reopen-request', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  // Fix round (four-lens, MED) — a staff preview of a terminal quote's portal
  // is not a customer ask. Checked before ANY DB work (mirrors view/route.ts
  // + interested/route.ts exactly) and, critically, before the cooldown claim
  // below: a staff click must never burn the customer's 1-hour cooldown slot.
  if (await isStaffPreview(req)) {
    return NextResponse.json({ ok: true, skipped: 'staff' });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, quote_number, customer_name, customer_address, customer_phone, customer_email, highlevel_contact_id, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, status',
    )
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Only a genuinely dead (declined/abandoned) quote can ask to be reopened —
  // canRevive is the SAME predicate the staff /send route uses to decide
  // whether a re-send is a legal revive, so this route can never drift from
  // that definition. Any other status 409s (mirrors the sibling routes'
  // "cannot X from status Y" shape).
  const current = deriveStatus(quote);
  if (!canRevive(current)) {
    return NextResponse.json(
      { error: `Cannot request a reopen for a quote that is ${current}`, code: 'invalid-status' },
      { status: 409 },
    );
  }

  // Per-quote cooldown — no DB write here, so this is a best-effort dedupe
  // (an in-memory, per-serverless-instance window, same caveat as every other
  // checkRateLimitByKey caller in this repo). A cooled-down repeat click is
  // NOT an error — it's the intended "already told us" outcome.
  const cooldown = checkRateLimitByKey(id, {
    bucket: 'quote-reopen-request-cooldown',
    limit: 1,
    windowMs: REOPEN_REQUEST_COOLDOWN_MS,
  });
  if (!cooldown.ok) {
    return NextResponse.json({ ok: true, skipped: 'cooldown' });
  }

  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (isHighLevelConfigured() && internalContactId) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    try {
      await sendEmail({
        contactId: internalContactId,
        subject: internalReopenRequestedEmailSubject({
          customerName: quote.customer_name,
          quoteNumber: quote.quote_number,
        }),
        html: internalReopenRequestedEmailHtml({
          customerName: quote.customer_name,
          quoteNumber: quote.quote_number,
          address: quote.customer_address,
          phone: quote.customer_phone,
          email: quote.customer_email,
          status: current,
          portalUrl: `${baseUrl}/portal/${id}`,
          adminUrl: `${baseUrl}/quote/${id}`,
        }),
        emailFrom,
      });
    } catch (err) {
      // Release the cooldown slot so a retry (their next click, or a page
      // reload) isn't locked out for the rest of the hour having received
      // nothing — mirrors referral request-link's sendAndStamp exactly.
      releaseRateLimitByKey(id, { bucket: 'quote-reopen-request-cooldown' });
      console.warn('[api/quotes/:id/reopen-request] staff email failed:', hlErrorMessage(err));
    }
  } else {
    // Unconfigured — a standing env state, not a one-off failure (mirrors
    // request-changes/route.ts's own comment for the same branch). One
    // console.warn is enough; never fail the customer's click over it.
    console.warn(
      '[api/quotes/:id/reopen-request] staff email skipped — HighLevel not configured or HIGHLEVEL_INTERNAL_CONTACT_ID unset',
    );
  }

  return NextResponse.json({ ok: true });
}
