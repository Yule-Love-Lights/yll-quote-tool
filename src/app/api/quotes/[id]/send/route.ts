// Admin-triggered "Send Quote to Customer" action.
// Fired from /quote/new after saveQuote + render complete, when the operator
// hands the portal URL off to the customer (copied to clipboard, emailed,
// texted, whatever — the button doesn't care how the URL is delivered).
//
// POST /api/quotes/[id]/send[?retryGhl]
// Body: {}  — no payload needed; the quote id is in the URL.
// ?retryGhl re-runs ONLY the GHL stage-sync for an already-sent quote whose
//   pipeline card never advanced (ghl_stage_synced_at IS NULL) — no re-stamp,
//   no re-message (audit fix: send-route-ghl-sync-state).
// Response:
//   { ok: true, sentAt: ISO, stageUpdated: boolean, ghlSynced: boolean,
//     ghlRetry: boolean, alreadySent?: boolean }
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
import { requireOperator } from '@/lib/auth/supabaseServer';
import { deriveStatus } from '@/lib/quoteStatus';

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
  // #107: the saved pricing result carries the "Full Yule" ceiling total; the
  // Bid-Sent card value uses it (falling back to `total` on pre-#107 quotes).
  result: { total?: number | null; fullYule?: { total?: number | null } | null } | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  viewed_at: string | null;
  // The persisted lifecycle status — used to detect changes_requested and
  // allow a legitimate re-send instead of short-circuiting on quote_sent_at.
  status: string | null;
  // Audit fix (send-route-ghl-sync-state): the GHL stage-sync outcome is
  // tracked separately from quote_sent_at so a quote whose pipeline card
  // never advanced is discoverable + retryable.
  ghl_stage_synced_at: string | null;
  // Test Quote (ledger #93): true ⇒ simulate the send (stamp quote_sent_at but
  // never move a real GHL card or text/email the customer).
  is_test: boolean;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
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

  // Audit fix (send-route-ghl-sync-state): ?retryGhl re-runs ONLY the GHL
  // stage-sync block for a quote that was already sent locally but whose
  // pipeline card never advanced (ghl_stage_synced_at IS NULL). This decouples
  // the local-send idempotency key (quote_sent_at) from the GHL-stage key so a
  // failed card move can be reconciled without re-stamping/re-messaging.
  const retryGhl = req.nextUrl.searchParams.get('retryGhl') != null;

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, highlevel_opportunity_id, highlevel_contact_id, customer_name, total, result, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, status, ghl_stage_synced_at, is_test')
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
  //
  // Audit fix (send-route-ghl-sync-state): the one EXCEPTION is an explicit
  // ?retryGhl reconcile for a quote that was sent locally but whose pipeline
  // card never synced (ghl_stage_synced_at IS NULL). In that case we fall
  // through to re-run ONLY the GHL stage block — we do NOT re-stamp
  // quote_sent_at and we SKIP the customer SMS/email (already delivered on the
  // original send) so a retry can't double-message the customer.
  //
  // Bug fix (B1): a 'changes_requested' quote is a legitimate re-send —
  // the customer asked for changes, staff edited the quote, and now need to
  // deliver the revised version. canTransition('changes_requested','sent') is
  // legal, and pipelineActions offers Send for this status. Fall through to
  // the full send path (re-stamp status='sent', re-message, re-advance GHL)
  // instead of short-circuiting on quote_sent_at.
  const currentStatus = deriveStatus({
    quote_sent_at: quote.quote_sent_at,
    customer_approved_at: quote.customer_approved_at,
    deposit_paid_at: quote.deposit_paid_at,
    viewed_at: quote.viewed_at,
    status: (quote.status as import('@/lib/quoteStatus').QuoteStatus | null) ?? null,
  });
  const isResend = currentStatus === 'changes_requested';
  const isGhlRetry = !!quote.quote_sent_at && retryGhl && quote.ghl_stage_synced_at == null;
  if (quote.quote_sent_at && !isGhlRetry && !isResend) {
    return NextResponse.json({
      ok: true,
      sentAt: quote.quote_sent_at,
      stageUpdated: false,
      alreadySent: true,
    });
  }

  // Require a linked HighLevel contact for a real (non-test) send. Without one
  // the customer is never texted/emailed (the messaging block below is gated on
  // highlevel_contact_id) and there's no card to advance — so a "send" with no
  // contact silently reaches nobody. Block BEFORE stamping so the quote isn't
  // falsely marked "sent". Test quotes are exempt (they simulate the whole flow
  // and never touch a real contact); a ?retryGhl reconcile is exempt too (the
  // original send already passed this gate).
  if (!isGhlRetry && !quote.is_test && !quote.highlevel_contact_id) {
    return NextResponse.json(
      {
        error:
          'Pick a HighLevel contact for this quote before sending — without one we can’t text or email the customer or move their pipeline card.',
        code: 'no-contact',
      },
      { status: 400 },
    );
  }

  // On a GHL-only retry the quote keeps its original sent timestamp.
  // On a resend (changes_requested → sent) we re-stamp with the current
  // time so the audit trail reflects when the revised quote was delivered.
  const sentAt = (isGhlRetry && !isResend)
    ? (quote.quote_sent_at ?? new Date().toISOString())
    : new Date().toISOString();

  // Stamp the DB FIRST (fresh send only), before the HL call, so we don't
  // double-fire the stage move on retries. Same pattern as /approve.
  if (!isGhlRetry) {
    const { error: stampErr } = await sb
      .from('quotes')
      // Advance the explicit lifecycle status alongside the timestamp (ledger
      // #83). quote_sent_at stays the idempotency key; status mirrors it so the
      // explicit-status read path agrees with deriveStatus().
      .update({ quote_sent_at: sentAt, status: 'sent' })
      .eq('id', id);
    if (stampErr) {
      console.error('[api/quotes/:id/send] stamp failed:', stampErr);
      return NextResponse.json(
        { error: `Failed to mark quote sent: ${stampErr.message}` },
        { status: 500 },
      );
    }
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
  // Card title = the customer's name; value = the "Full Yule" ceiling (#107),
  // falling back to the billed total on pre-#107 quotes.
  const cardName = quote.customer_name?.trim() || 'Yule Love Lights quote';
  const ceilingTotal = quote.result?.fullYule?.total;
  const monetaryValue =
    typeof ceilingTotal === 'number'
      ? ceilingTotal
      : typeof quote.total === 'number'
        ? quote.total
        : undefined;

  if (quote.is_test) {
    // Test Quote (#93): simulate the send — never move a real GHL pipeline card.
    // stageUpdated stays false; the sync-outcome write below marks it "synced"
    // so the quote doesn't show as stuck / retryable in the admin UI.
    stageError = undefined;
  } else if (!isHighLevelConfigured()) {
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

  // Audit fix (send-route-ghl-sync-state, finding #32): persist the stage-sync
  // OUTCOME durably so a card that never advanced is discoverable + retryable,
  // instead of leaving the only trace in a console line. On success clear the
  // error and stamp ghl_stage_synced_at; on failure record the reason and leave
  // ghl_stage_synced_at NULL (the ?retryGhl reconcile bucket). This write is
  // itself best-effort — its failure only logs, never undoes the send.
  {
    // Test Quote (#93): mark the sync done (no real card moved, but the quote
    // shouldn't look stuck). Otherwise the real success/failure outcome.
    const syncPayload = quote.is_test || stageUpdated
      ? { ghl_stage_synced_at: new Date().toISOString(), ghl_sync_error: null }
      : { ghl_sync_error: stageError ?? 'GHL stage not synced' };
    const { error: syncErr } = await sb.from('quotes').update(syncPayload).eq('id', id);
    if (syncErr) {
      console.warn('[api/quotes/:id/send] failed to persist GHL sync state:', syncErr.message);
    }
  }

  // Deliver the portal link to the customer via GHL — SMS + Email — so it lands
  // in the Conversations tab (#37). Non-fatal: a messaging failure doesn't undo
  // the send; the operator can still hand off the link manually.
  // Audit fix (send-route-ghl-sync-state): SKIP messaging on a GHL-only retry —
  // the customer was already messaged on the original send; a reconcile must
  // not re-text/re-email them.
  let smsSent = false;
  let emailSent = false;
  let messageError: string | undefined;
  // Test Quote (#93): never text/email a real customer for a simulated send.
  if (!isGhlRetry && !quote.is_test && isHighLevelConfigured() && quote.highlevel_contact_id) {
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
    // Audit fix (send-route-ghl-sync-state): ghlRetry flags a reconcile run so
    // the operator UI can distinguish it from a fresh send; ghlSynced lets the
    // UI surface the durable sync state (and offer a retry when false).
    ghlRetry: isGhlRetry,
    ghlSynced: stageUpdated,
    smsSent,
    emailSent,
    messageError,
  });
}
