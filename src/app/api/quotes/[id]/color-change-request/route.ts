// Customer-requested colour change on a BOOKED order (ledger #163).
//
// POST /api/quotes/[id]/color-change-request   (public — quote UUID is the token)
// Body: { colorSchemeId?: string, customPattern?: string[] }
// Response: { ok: true, label } | { error, code? }
//
// A booked customer previews a different light colour on the portal and asks us
// to change it. This does NOT alter the booked order — it records the requested
// colour on the quote (approval_snapshot.pendingColorRequest) so staff can review
// + apply it deliberately (ledger #163 "one-click apply", separate route), drops
// an /inbox notification so it lands in the operator queue, and (ledger row 319)
// fires a best-effort internal staff email immediately so the request is never
// visible ONLY in /inbox — both the email and the inbox ping are independent
// best-effort sends; either failing never fails the customer's already-saved
// request. (Ledger row 308) a send FAILURE is itself logged to
// dashboard_activity (rendered by /inbox/activity) rather than only a Vercel
// log line — see the catch branch below. The colour is sanitized here exactly
// like the approve route (never trust the client), so a later apply re-freezes
// a known-good scheme/pattern.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { getAppSettings } from '@/lib/appSettings';
import {
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  isKnownColorSchemeId,
  sanitizeCustomPattern,
  getColorScheme,
  type ColorScheme,
} from '@/lib/design/colorSchemes';
import { resolveColorChoice } from '@/lib/inventory/resolveInstalls';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { ingestTouch } from '@/lib/dashboard/inbox/store';
import type { NormalizedTouch } from '@/lib/dashboard/inbox/types';
import { sendEmail, isHighLevelConfigured, HighLevelError } from '@/lib/integrations/highlevel';
import {
  internalColorChangeRequestedEmailSubject,
  internalColorChangeRequestedEmailHtml,
} from '@/lib/integrations/quoteMessages';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors request-changes/route.ts's helper: extract the real HighLevel error
// message rather than logging the raw error object.
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
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  highlevel_contact_id: string | null;
  service_type: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  quote_sent_at: string | null;
  status: QuoteStatus | null;
  total: number | null;
  approval_snapshot: { customerSelection?: unknown; [key: string]: unknown } | null;
};

/** Human label for the requested colour, for the inbox preview + the staff panel. */
export function colorChangeLabel(
  colorSchemeId: string,
  customPattern: string[],
  schemes?: ColorScheme[],
): string {
  if (colorSchemeId === CUSTOM_SCHEME_ID || customPattern.length > 0) {
    return `Custom pattern (${customPattern.length} colour${customPattern.length === 1 ? '' : 's'})`;
  }
  return getColorScheme(colorSchemeId, schemes).label;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  // A customer isn't clicking this many times a minute; block a bot spamming it.
  const rl = rateLimitResponse(req, { bucket: 'color-change-request', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: { colorSchemeId?: unknown; customPattern?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_email, customer_phone, customer_address, highlevel_contact_id, service_type, customer_approved_at, deposit_paid_at, quote_sent_at, status, total, approval_snapshot',
    )
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }
  // Only an approved/booked order has colours to change.
  if (!quote.customer_approved_at || !quote.approval_snapshot?.customerSelection) {
    return NextResponse.json(
      { error: 'This order is not booked yet', code: 'not-booked' },
      { status: 409 },
    );
  }
  // A dead order (cancelled/declined/abandoned) can't take colour-change requests —
  // mirror the sibling routes (amend / free-items / apply) that reject terminal.
  const lifecycle = deriveStatus({
    quote_sent_at: quote.quote_sent_at,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    status: quote.status,
  });
  if (lifecycle === 'cancelled' || lifecycle === 'declined' || lifecycle === 'abandoned') {
    return NextResponse.json(
      { error: `This order is ${lifecycle}`, code: 'not-editable' },
      { status: 409 },
    );
  }

  // Sanitize the requested colour EXACTLY like the approve route: validate the
  // scheme id against the live swatch list for this vertical, sanitize a custom
  // pattern against the buildable palette, and resolve the effective color ids.
  const isPermanent = quote.service_type === 'permanent';
  const { swatches, permanentSwatches } = await getAppSettings();
  const activeSchemes = isPermanent ? permanentSwatches.schemes : swatches.schemes;
  const activeBuildable = isPermanent ? permanentSwatches.buildableColorIds : swatches.buildableColorIds;

  const requestedSchemeId = isKnownColorSchemeId(body.colorSchemeId, activeSchemes)
    ? (body.colorSchemeId as string)
    : DEFAULT_COLOR_SCHEME_ID;
  const customPattern =
    requestedSchemeId === CUSTOM_SCHEME_ID ? sanitizeCustomPattern(body.customPattern, activeBuildable) : [];
  // Collapse an empty custom pick back to the default (mirrors the approve route).
  const colorSchemeId =
    requestedSchemeId === CUSTOM_SCHEME_ID && customPattern.length === 0
      ? DEFAULT_COLOR_SCHEME_ID
      : requestedSchemeId;
  const colorIds = resolveColorChoice(colorSchemeId, customPattern, activeSchemes);
  const label = colorChangeLabel(
    colorSchemeId,
    customPattern,
    isPermanent ? activeSchemes : undefined,
  );

  // Record the request on the quote (the source of truth the staff apply reads).
  const pendingColorRequest = {
    colorSchemeId,
    customPattern,
    colorIds,
    label,
    requestedAt: new Date().toISOString(),
  };
  // Compare-and-swap on the FULL snapshot (mirrors amend/route.ts): re-fetch the
  // current snapshot immediately before the write and only write if it hasn't
  // changed since. A blind write here would clobber a concurrent staff amend —
  // erasing its trail entry and silently reverting the agreed total (F-014).
  const { data: freshRow } = await sb
    .from('quotes')
    .select('approval_snapshot')
    .eq('id', id)
    .maybeSingle<{ approval_snapshot: QuoteRow['approval_snapshot'] }>();
  const priorSnapshot = freshRow?.approval_snapshot ?? quote.approval_snapshot;
  const newSnapshot = { ...priorSnapshot, pendingColorRequest };
  const { data: updatedRows, error: upErr } = await sb
    .from('quotes')
    .update({ approval_snapshot: newSnapshot })
    .eq('id', id)
    // Serialize jsonb explicitly — PostgREST string-interpolates filter values.
    .eq('approval_snapshot', JSON.stringify(priorSnapshot))
    .select('id');
  if (upErr) {
    console.error('[api/quotes/:id/color-change-request] save failed:', upErr);
    return NextResponse.json({ error: 'Could not record your request' }, { status: 500 });
  }
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json(
      { error: 'The order was just updated — please try again.', code: 'concurrent-edit' },
      { status: 409 },
    );
  }

  // Notify staff via the unified inbox (best-effort — the request is already
  // saved on the quote, so an inbox hiccup never loses it). Reuses the quotetool
  // source with a distinct external_id so it never collides with the quote-sent
  // reconcile item (bare quote id) or the legacy-rebook exclusion.
  const touch: NormalizedTouch = {
    source: 'quotetool',
    externalId: `${id}:color-request`,
    direction: 'inbound',
    channel: null,
    lastMessageAt: new Date(),
    preview: `Colour change requested: ${label}`,
    subject: 'Colour change request',
    identity: {
      ghlContactId: quote.highlevel_contact_id,
      emails: quote.customer_email ? [quote.customer_email] : [],
      phones: quote.customer_phone ? [quote.customer_phone] : [],
      displayName: quote.customer_name,
    },
    raw: { quoteId: id, colorSchemeId, customPattern, label, kind: 'color-change-request' },
    leadKind: 'lead',
    quoteValue: quote.total,
  };
  // Captured for the send-failure activity write below (row 308) — links a
  // failed staff email to the same inbox item the ping above just created, when
  // it succeeded. Stays null on a skipped/failed ingest; the activity write
  // below tolerates that (inbox_item_id is nullable).
  let inboxItemId: string | null = null;
  try {
    const outcome = await ingestTouch(touch, new Date());
    if (outcome.ok) inboxItemId = outcome.itemId;
  } catch (e) {
    console.warn('[api/quotes/:id/color-change-request] inbox notify failed (request still saved):', e);
  }

  // Immediate internal staff email (ledger row 319) — the /inbox row above is
  // easy to miss (Susan Pace-Burke's request sat unanswered 3 days; Kristie
  // Tibbetts' was dismissed same-day with no email ever firing). Best-effort,
  // independent of the inbox ping above: a send failure here must never fail
  // the customer's already-saved request. Mirrors request-changes/route.ts's
  // internal-alert pattern exactly (same shape: a customer portal action on an
  // existing quote that needs a staff look).
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (isHighLevelConfigured() && internalContactId) {
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    try {
      await sendEmail({
        contactId: internalContactId,
        subject: internalColorChangeRequestedEmailSubject(quote.customer_name),
        html: internalColorChangeRequestedEmailHtml({
          customerName: quote.customer_name,
          address: quote.customer_address,
          phone: quote.customer_phone,
          email: quote.customer_email,
          label,
          portalUrl: `${baseUrl}/portal/${id}`,
          // The general quote builder (/quote/<id>) has zero awareness of
          // pendingColorRequest — ColorRequestPanel (the actual apply/dismiss UI)
          // renders only on the admin quote detail page. Point the email there.
          adminUrl: `${baseUrl}/admin/quotes/${id}`,
        }),
        emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
      });
    } catch (err) {
      const message = hlErrorMessage(err);
      console.error('[api/quotes/:id/color-change-request] staff email failed (request still saved):', message);
      // Row 308: a failed send used to leave no trace beyond a Vercel log stream
      // nobody opens (same reasoning as recordSuppressedFollowUp, store.ts).
      // Logs to dashboard_activity so /inbox/activity surfaces it —
      // 'color_request_email_failed' is not in listActivity's ingested/escalated
      // exclusion, so it renders there. Best-effort and deliberately swallowed:
      // an audit-write failure must never turn this already-swallowed send
      // failure into anything that blocks the response.
      try {
        await sb.from('dashboard_activity').insert({
          actor: 'system',
          action: 'color_request_email_failed',
          inbox_item_id: inboxItemId,
          detail: { quoteId: id, label, error: message },
        });
      } catch (e) {
        console.warn('[api/quotes/:id/color-change-request] activity write for email failure failed (non-fatal):', e);
      }
    }
  } else {
    // Unconfigured (HighLevel off, or no internal contact id set) — this is a
    // standing env state, not a one-off failure: it would fire on EVERY colour
    // request while unset, so a dashboard_activity row per request would spam
    // the log the same way the review flagged the original silent skip for
    // being invisible. One console.warn is enough to surface it to whoever
    // reads Vercel logs without flooding /inbox/activity.
    console.warn(
      '[api/quotes/:id/color-change-request] staff email skipped — HighLevel not configured or HIGHLEVEL_INTERNAL_CONTACT_ID unset',
    );
  }

  return NextResponse.json({ ok: true, label });
}
