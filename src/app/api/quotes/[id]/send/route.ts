// Admin-triggered "Send Quote to Customer" action.
// Fired from /quote/new after saveQuote + render complete, when the operator
// hands the portal URL off to the customer (copied to clipboard, emailed,
// texted, whatever — the button doesn't care how the URL is delivered).
//
// POST /api/quotes/[id]/send
// Body: {}  — no payload needed; the quote id is in the URL.
// Response:
//   { ok: true, sentAt: ISO, stageUpdated: boolean, alreadySent?: boolean }
//   { error: string, code?: string }
//
// What happens:
//   1. Validate the quote id
//   2. Load the quote row (need highlevel_opportunity_id + quote_sent_at for idempotency)
//   3. Stamp quote_sent_at if not already set
//   4. If HL opportunity is linked: move the pipeline card to HIGHLEVEL_STAGE_QUOTE_SENT
//      ("Bid Sent"). Non-fatal on failure — the quote is still "sent" locally.
//   5. Return success
//
// Auth model: same as /approve — the quote UUID is the capability token.
// In practice this is only called from the admin UI, but we don't enforce
// admin auth here because (a) admin auth is not yet wired in the app and
// (b) the side effects are low-risk (stage move + timestamp). If abused,
// the worst case is a stage-move spam on an opportunity the attacker
// already has the UUID for.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  createOpportunity,
  updateOpportunity,
  findOpportunityForContact,
  sendSms,
  sendEmail,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import {
  QUOTE_EMAIL_SUBJECT,
  quoteSmsBody,
  quoteEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

// The linked card was deleted in GHL (our stored opportunity id is stale) —
// GHL answers the update with a 400/404 "doesn't exist or is deleted". When we
// see that, we recreate the card instead of failing.
function isMissingOpportunity(err: unknown): boolean {
  return (
    err instanceof HighLevelError &&
    (err.status === 400 || err.status === 404) &&
    /doesn't exist|does not exist|deleted/i.test(err.body ?? '')
  );
}

type QuoteRow = {
  id: string;
  highlevel_opportunity_id: string | null;
  highlevel_contact_id: string | null;
  customer_name: string | null;
  total: number | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured' },
      { status: 503 },
    );
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-send', limit: 20, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, highlevel_opportunity_id, highlevel_contact_id, customer_name, total, quote_sent_at, customer_approved_at')
    .eq('id', id)
    .single<QuoteRow>();

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // Idempotency — if already sent, short-circuit and skip the stage move.
  // We don't re-ping HighLevel if the admin double-clicks, because the
  // stage may already have advanced past "Bid Sent" (customer could have
  // approved in between) and we don't want to yank it back.
  if (quote.quote_sent_at) {
    return NextResponse.json({
      ok: true,
      sentAt: quote.quote_sent_at,
      stageUpdated: false,
      alreadySent: true,
    });
  }

  const sentAt = new Date().toISOString();

  // Stamp the DB FIRST, before the HL call, so we don't double-fire the
  // stage move on retries. Same pattern as /approve.
  const { error: stampErr } = await sb
    .from('quotes')
    .update({ quote_sent_at: sentAt })
    .eq('id', id);
  if (stampErr) {
    console.error('[api/quotes/:id/send] stamp failed:', stampErr);
    return NextResponse.json(
      { error: `Failed to mark quote sent: ${stampErr.message}` },
      { status: 500 },
    );
  }

  // HighLevel (#37): move the customer's opportunity to "📨Bid Sent" — creating
  // the card at that stage if they don't have one yet — and set the card title
  // ("FirstName LastName"), value (quote total), and Source ("Quote Tool", on
  // cards we create). Non-fatal on failure; the operator already has the URL
  // and we've recorded the send, so an admin can reconcile a stuck card later.
  let stageUpdated = false;
  let opportunityId = quote.highlevel_opportunity_id;
  let opportunityCreated = false;
  let stageError: string | undefined;

  const stageSent = process.env.HIGHLEVEL_STAGE_QUOTE_SENT;
  const pipelineId = process.env.HIGHLEVEL_PIPELINE_ID;
  // Card title = the customer's name; value = the quote total.
  const cardName = quote.customer_name?.trim() || 'Yule Love Lights quote';
  const monetaryValue = typeof quote.total === 'number' ? quote.total : undefined;

  if (!isHighLevelConfigured()) {
    stageError = 'HighLevel not configured';
  } else if (!stageSent || !pipelineId) {
    stageError = 'HIGHLEVEL_STAGE_QUOTE_SENT / HIGHLEVEL_PIPELINE_ID not set';
  } else {
    // 1. If a card is already linked, advance it to Bid Sent + refresh its
    //    title/value. If it was deleted in GHL, drop the stale id and fall
    //    through to find-or-create below.
    if (opportunityId) {
      try {
        await updateOpportunity(opportunityId, { pipelineStageId: stageSent, name: cardName, monetaryValue });
        stageUpdated = true;
      } catch (err) {
        if (isMissingOpportunity(err)) {
          opportunityId = null;
        } else {
          console.warn('[api/quotes/:id/send] HL opportunity update failed:', err);
          stageError = hlErrorMessage(err);
        }
      }
    }
    // 2. No usable linked card → reuse the contact's existing card if they have
    //    one (GHL allows only one open card per contact per pipeline), else
    //    create a fresh card. Either path ends at Bid Sent with our title/value.
    if (!stageUpdated && !stageError) {
      if (!quote.highlevel_contact_id) {
        stageError = 'No HighLevel contact linked to this quote';
      } else {
        try {
          const existing = await findOpportunityForContact(quote.highlevel_contact_id, pipelineId);
          if (existing) {
            await updateOpportunity(existing.id, { pipelineStageId: stageSent, name: cardName, monetaryValue });
            opportunityId = existing.id;
          } else {
            const created = await createOpportunity({
              contactId: quote.highlevel_contact_id,
              pipelineId,
              pipelineStageId: stageSent,
              name: cardName,
              monetaryValue,
              source: 'Quote Tool',
            });
            opportunityId = created.id;
            opportunityCreated = true;
          }
          stageUpdated = true;
          // Persist the resolved card id so future send/approve calls find it.
          const { error: linkErr } = await sb
            .from('quotes')
            .update({ highlevel_opportunity_id: opportunityId })
            .eq('id', id);
          if (linkErr) {
            console.warn('[api/quotes/:id/send] failed to relink opportunity id:', linkErr.message);
          }
        } catch (err) {
          console.warn('[api/quotes/:id/send] find-or-create opportunity failed:', err);
          stageError = hlErrorMessage(err);
        }
      }
    }
  }

  // Deliver the portal link to the customer via GHL — SMS + Email — so it lands
  // in the Conversations tab (#37). Non-fatal: a messaging failure doesn't undo
  // the send; the operator can still hand off the link manually.
  let smsSent = false;
  let emailSent = false;
  let messageError: string | undefined;
  if (isHighLevelConfigured() && quote.highlevel_contact_id) {
    const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
    const baseUrl = (process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '');
    const portalUrl = `${baseUrl}/portal/${id}`;
    const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;
    try {
      await sendSms({
        contactId: quote.highlevel_contact_id,
        message: quoteSmsBody(firstName, portalUrl),
        fromNumber,
      });
      smsSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send] SMS send failed:', err);
      messageError = hlErrorMessage(err);
    }
    try {
      await sendEmail({
        contactId: quote.highlevel_contact_id,
        subject: QUOTE_EMAIL_SUBJECT,
        html: quoteEmailHtml(firstName, portalUrl),
        emailFrom,
      });
      emailSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send] Email send failed:', err);
      messageError = (messageError ? `${messageError}; ` : '') + hlErrorMessage(err);
    }
  }

  return NextResponse.json({
    ok: true,
    sentAt,
    stageUpdated,
    opportunityCreated,
    opportunityId,
    stageError,
    smsSent,
    emailSent,
    messageError,
  });
}
