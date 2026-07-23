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
// #116 (re-send half): a DECLINED or LOST quote is revivable — this route
//   treats it as a fresh send (re-stamp quote_sent_at + status='sent',
//   re-message the customer, re-advance the GHL card to Bid Sent) instead of
//   short-circuiting on the old quote_sent_at. CANCELLED stays excluded
//   (post-booking — refunds are manual, rebook-only). A revive with
//   deposit_paid_at already set is refused 409 (fail closed).
// Response:
//   { ok: true, sentAt: ISO, stageUpdated: boolean, ghlSynced: boolean,
//     ghlRetry: boolean, alreadySent?: boolean, revived?: true }
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
// Auth model: operator-gated — requireOperator() is called below, same as the
// other admin-triggered quote actions. (Historically this route also relied on
// the quote UUID as a capability token before the operator gate was wired in;
// that no longer applies now that admin auth is enforced.)

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  createOpportunity,
  updateOpportunity,
  findOpportunityForContact,
  parseDuplicateOpportunityError,
  upsertContactCustomField,
  sendSms,
  sendEmail,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { resolvePipelineStages, quoteLinkFieldId, quoteLinkFieldEnvVar } from '@/lib/integrations/ghlPipelineMap';
import {
  quoteEmailSubject,
  quoteSmsBody,
  quoteEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { deriveStatus, canRevive } from '@/lib/quoteStatus';

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
  // Which GHL pipeline this quote's card lives in (resolvePipelineStages).
  service_type: string | null;
  total: number | null;
  // #107: the saved pricing result carries the "Full Yule" ceiling total; the
  // Bid-Sent card value uses it (falling back to `total` on pre-#107 quotes).
  result: {
    total?: number | null;
    fullYule?: { total?: number | null } | null;
    lineItems?: Array<{ amount?: number | null }> | null;
  } | null;
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
  // Legacy rebook (#156): routes to the Neighbors pipeline instead of the
  // service_type's own map — see resolvePipelineStages.
  legacy_rebook: boolean;
};

export function hasDeliverableQuoteResult(
  result: QuoteRow['result'],
): boolean {
  if (!result || typeof result.total !== 'number' || result.total <= 0) return false;
  return (
    Array.isArray(result.lineItems) &&
    result.lineItems.some((item) => typeof item?.amount === 'number' && item.amount > 0)
  );
}


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
  // A delivery-only retry re-sends the requested customer channel(s) for a
  // locally-sent quote without re-stamping the lifecycle or moving the CRM card.
  const retryDelivery = req.nextUrl.searchParams.get('retryDelivery') != null;

  // Task 10 — Send channel split: accept an optional body { channel?: 'email' | 'sms' | 'both' }.
  // Default is 'both' (back-compat — the admin Send button posts no body).
  // Guard against a double-read: the body is only ever read once here.
  let sendBody: { channel?: unknown } = {};
  try { sendBody = await req.json(); } catch { sendBody = {}; }
  const channel = (sendBody.channel === 'sms' || sendBody.channel === 'email' || sendBody.channel === 'both')
    ? sendBody.channel
    : 'both';
  const doSms   = channel === 'both' || channel === 'sms';
  const doEmail = channel === 'both' || channel === 'email';

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, highlevel_opportunity_id, highlevel_contact_id, customer_name, service_type, total, result, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, status, ghl_stage_synced_at, is_test, legacy_rebook')
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
  // #116 (re-send half): declined/lost are REVIVABLE — the operator re-sends
  // the SAME quote instead of rebooking a new draft. Deliberately a scoped
  // bypass here (canRevive), NOT a widened ALLOWED_TRANSITIONS entry — see
  // quoteStatus.ts. 'cancelled' is excluded (post-booking; refunds are
  // manual, rebook-only).
  const isRevive = canRevive(currentStatus);

  // Money guard, fail closed: a revivable status shouldn't carry a paid
  // deposit (the decline routes guard their write on deposit_paid_at IS
  // NULL), but a data-drifted row must never sneak a paid quote back open.
  // Checked before any write.
  if (isRevive && quote.deposit_paid_at) {
    return NextResponse.json(
      {
        error: 'Cannot revive a quote with a deposit already paid — refunds are manual.',
        code: 'deposit-paid',
      },
      { status: 409 },
    );
  }

  // Bug fix (W1-017): the ?retryGhl reconcile must also check the CURRENT status.
  // ghl_stage_synced_at only tracks the SEND-stage sync, so if the original send's
  // card move failed it stays NULL forever — keeping the retry affordance live even
  // after the customer approves and pays. Running the retry then re-issues the
  // "Bid Sent" stage move (HIGHLEVEL_STAGE_QUOTE_SENT) and yanks a PAID job's card
  // backwards, losing the booked deal in the pipeline. Only a quote still at
  // 'sent'/'viewed' is retry-eligible; an approved/booked/terminal quote falls
  // through to the alreadySent short-circuit and never touches GHL.
  const isGhlRetry =
    !!quote.quote_sent_at &&
    retryGhl &&
    quote.ghl_stage_synced_at == null &&
    (currentStatus === 'sent' || currentStatus === 'viewed');
  const isDeliveryRetry =
    !!quote.quote_sent_at &&
    retryDelivery &&
    (currentStatus === 'sent' || currentStatus === 'viewed');
  if (quote.quote_sent_at && !isGhlRetry && !isDeliveryRetry && !isResend && !isRevive) {
    return NextResponse.json({
      ok: true,
      sentAt: quote.quote_sent_at,
      stageUpdated: false,
      alreadySent: true,
    });
  }

  // Reject a quote whose current portal projection has no priced item. The
  // portal's finalized placeholder remains defense in depth for historical rows,
  // but a fresh send must never deliver that dead-end to a customer. GHL-only and
  // delivery-only retries operate on an already-sent quote and bypass this guard.
  if (!isGhlRetry && !isDeliveryRetry && !hasDeliverableQuoteResult(quote.result)) {
    return NextResponse.json(
      {
        error: 'Add at least one priced line item and calculate the quote before sending.',
        code: 'empty-quote',
      },
      { status: 409 },
    );
  }

  // Require a linked HighLevel contact for a real (non-test) send. Without one
  // the customer is never texted/emailed (the messaging block below is gated on
  // highlevel_contact_id) and there's no card to advance — so a "send" with no
  // contact silently reaches nobody. Block BEFORE stamping so the quote isn't
  // falsely marked "sent". Test quotes are exempt (they simulate the whole flow
  // and never touch a real contact); a ?retryGhl reconcile is exempt too (the
  // original send already passed this gate).
  if (!isGhlRetry && !quote.is_test && !quote.highlevel_contact_id) {
    const customerLabel = quote.customer_name?.trim() || 'this customer';
    return NextResponse.json(
      {
        error:
          `No HighLevel contact linked for ${customerLabel} — a matching contact must already exist in HighLevel and be linked to this quote before sending (we never auto-create one). Link a contact from the search, then send again.`,
        code: 'no-contact',
      },
      { status: 400 },
    );
  }

  // On a GHL-only retry the quote keeps its original sent timestamp.
  // On a resend (changes_requested → sent) or a revive (declined/lost → sent)
  // we re-stamp with the current time so the audit trail reflects when the
  // quote was (re-)delivered.
  const sentAt = ((isGhlRetry || isDeliveryRetry) && !isResend)
    ? (quote.quote_sent_at ?? new Date().toISOString())
    : new Date().toISOString();

  // Stamp the DB FIRST (fresh send only), before the HL call, so we don't
  // double-fire the stage move on retries. Same pattern as /approve.
  if (!isGhlRetry && !isDeliveryRetry) {
    // Advance the explicit lifecycle status alongside the timestamp (ledger
    // #83). quote_sent_at stays the idempotency key; status mirrors it so the
    // explicit-status read path agrees with deriveStatus().
    const stampPayload: Record<string, unknown> = { quote_sent_at: sentAt, status: 'sent' };
    if (isRevive) {
      // #116: force deriveStatus to read 'sent' the moment this row is next
      // loaded. deriveStatus only trusts a persisted status for the
      // declined/cancelled/lost/changes_requested branch states — NOT 'sent'
      // — so writing status='sent' alone falls straight through to the
      // timestamp fallback underneath it. A declined quote can carry a stale
      // customer_approved_at (#124 lets decline fire from 'approved') and/or
      // a stale viewed_at from the ORIGINAL send; either would independently
      // outrank quote_sent_at in that fallback and resurrect the quote to
      // 'approved'/'viewed' instead of 'sent'. Clear both. decline_reason /
      // approval_snapshot are left untouched — they don't feed deriveStatus
      // and are useful history ("declined once, revived on <date>").
      stampPayload.customer_approved_at = null;
      stampPayload.viewed_at = null;
    }
    const { error: stampErr } = await sb
      .from('quotes')
      .update(stampPayload)
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

  // Per-service-type pipeline/stage resolution (#GHL pipeline sync) — holiday
  // still honors the legacy HIGHLEVEL_PIPELINE_ID/STAGE_* env vars when set
  // (prod back-compat); permanent/event always use their own pipeline.
  // Legacy rebook (#156): legacy_rebook wins regardless of service_type,
  // routing to the Neighbors pipeline instead of Christmas Lights.
  const stages = resolvePipelineStages(quote.service_type, { legacyRebook: quote.legacy_rebook });
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
  // Computed early (moved up from the messaging block below) so the GHL stage
  // chain can also stamp it onto the contact's custom field once the card
  // move succeeds — reuses the EXACT same URL the customer is texted/emailed.
  const portalUrl = `${(process.env.PORTAL_BASE_URL || req.nextUrl.origin).replace(/\/+$/, '')}/portal/${id}`;

  // W1-050: the GHL stage-move chain (+ its durable sync-state write) and the two
  // customer messages (SMS, email) are mutually independent — the operator's Send
  // click waited on them one after another. Run them concurrently below via
  // Promise.allSettled. The stage chain KEEPS its internal order (update-linked →
  // find-or-create → relink → persist sync outcome); the messages keep their own
  // shape. Each task still logs its own failure non-fatally exactly as today.
  const ghlStageChain = async () => {
    if (isDeliveryRetry) return;
    if (quote.is_test) {
      // Test Quote (#93): simulate the send — never move a real GHL pipeline card.
      // stageUpdated stays false; the sync-outcome write below marks it "synced"
      // so the quote doesn't show as stuck / retryable in the admin UI.
      stageError = undefined;
    } else if (!isHighLevelConfigured()) {
      stageError = 'HighLevel not configured';
    } else {
      // 1. If a card is already linked, advance it to Bid Sent + refresh its
      //    title/value. If it was deleted in GHL, drop the stale id and fall
      //    through to find-or-create below.
      if (opportunityId) {
        try {
          await updateOpportunity(opportunityId, { pipelineStageId: stages.sent, name: cardName, monetaryValue });
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
      // 2. No usable linked card → reuse the contact's existing OPEN card if they
      //    have one, else create a fresh card — and if GHL rejects the create as a
      //    duplicate (#172: the location forbids a 2nd card per contact, and the
      //    find above skips won/lost/abandoned cards), RESURRECT the existing card
      //    instead. Either path ends at Bid Sent with our title/value.
      if (!stageUpdated && !stageError) {
        if (!quote.highlevel_contact_id) {
          stageError = 'No HighLevel contact linked to this quote';
        } else {
          try {
            const existing = await findOpportunityForContact(quote.highlevel_contact_id, stages.pipelineId);
            if (existing) {
              await updateOpportunity(existing.id, { pipelineStageId: stages.sent, name: cardName, monetaryValue });
              opportunityId = existing.id;
            } else {
              try {
                const created = await createOpportunity({
                  contactId: quote.highlevel_contact_id,
                  pipelineId: stages.pipelineId,
                  pipelineStageId: stages.sent,
                  name: cardName,
                  monetaryValue,
                  source: 'Quote Tool',
                });
                opportunityId = created.id;
                opportunityCreated = true;
              } catch (createErr) {
                // #172: contact already has a (non-open) card and GHL forbids a
                // second one. Reopen it, pull it into this pipeline at Bid Sent,
                // and overwrite title/value (Jason-approved re-engagement flow).
                const existingId = parseDuplicateOpportunityError(createErr);
                if (!existingId) throw createErr;
                await updateOpportunity(existingId, {
                  status: 'open',
                  pipelineId: stages.pipelineId,
                  pipelineStageId: stages.sent,
                  name: cardName,
                  monetaryValue,
                });
                opportunityId = existingId;
              }
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

    // Quote-link custom field: stamp the SAME portal URL we text/email the
    // customer onto their CONTACT (not the card) so a GHL workflow/automation
    // can merge {{contact.<field>}}. Only once the card move actually
    // succeeded, and never for a test quote (no real contact to touch).
    //
    // The field is resolved PER SERVICE TYPE (quoteLinkFieldId), not a single
    // shared field: each pipeline's own drip automations merge this field, and
    // one shared field would let e.g. a permanent send overwrite the link a
    // Christmas drip automation is about to merge (see ghlPipelineMap.ts). The
    // field id is dev-configured post-launch (the dev creates the field in GHL
    // and sets the per-type env var) — until then, skip silently with one warn
    // rather than treating a missing field as a send failure.
    if (stageUpdated && !quote.is_test && quote.highlevel_contact_id) {
      const fieldId = quoteLinkFieldId(quote.service_type, { legacyRebook: quote.legacy_rebook });
      if (!fieldId) {
        console.warn(
          `[api/quotes/:id/send] ${quoteLinkFieldEnvVar(quote.service_type, { legacyRebook: quote.legacy_rebook })} not set — skipping quote-link custom field stamp`,
        );
      } else {
        try {
          await upsertContactCustomField(quote.highlevel_contact_id, fieldId, portalUrl);
        } catch (err) {
          console.error('[api/quotes/:id/send] quote-link custom field stamp failed:', hlErrorMessage(err));
        }
      }
    }

    // Audit fix (send-route-ghl-sync-state, finding #32): persist the stage-sync
    // OUTCOME durably so a card that never advanced is discoverable + retryable,
    // instead of leaving the only trace in a console line. On success clear the
    // error and stamp ghl_stage_synced_at; on failure record the reason and leave
    // ghl_stage_synced_at NULL (the ?retryGhl reconcile bucket). This write is
    // itself best-effort — its failure only logs, never undoes the send.
    const syncPayload = quote.is_test || stageUpdated
      ? { ghl_stage_synced_at: new Date().toISOString(), ghl_sync_error: null }
      : { ghl_sync_error: stageError ?? 'GHL stage not synced' };
    const { error: syncErr } = await sb.from('quotes').update(syncPayload).eq('id', id);
    if (syncErr) {
      console.warn('[api/quotes/:id/send] failed to persist GHL sync state:', syncErr.message);
    }
  };

  // Deliver the portal link to the customer via GHL — SMS + Email — so it lands
  // in the Conversations tab (#37). Non-fatal: a messaging failure doesn't undo
  // the send; the operator can still hand off the link manually.
  // Audit fix (send-route-ghl-sync-state): SKIP messaging on a GHL-only retry —
  // the customer was already messaged on the original send; a reconcile must
  // not re-text/re-email them.
  let smsSent = false;
  let emailSent = false;
  let smsError: string | undefined;
  let emailError: string | undefined;
  // Test Quote (#93): never text/email a real customer for a simulated send.
  const canMessage =
    !isGhlRetry && !quote.is_test && isHighLevelConfigured() && !!quote.highlevel_contact_id;
  const firstName = quote.customer_name?.trim().split(/\s+/)[0] || 'there';
  const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
  const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;

  const customerSms = async () => {
    if (!canMessage || !doSms || !quote.highlevel_contact_id) return;
    try {
      await sendSms({
        contactId: quote.highlevel_contact_id,
        message: quoteSmsBody(firstName, portalUrl, quote.service_type),
        fromNumber,
      });
      smsSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send] SMS send failed:', err);
      smsError = hlErrorMessage(err);
    }
  };

  const customerEmail = async () => {
    if (!canMessage || !doEmail || !quote.highlevel_contact_id) return;
    try {
      await sendEmail({
        contactId: quote.highlevel_contact_id,
        subject: quoteEmailSubject(quote.service_type),
        html: quoteEmailHtml(firstName, portalUrl, quote.service_type),
        emailFrom,
      });
      emailSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send] Email send failed:', err);
      emailError = hlErrorMessage(err);
    }
  };

  await Promise.allSettled([ghlStageChain(), customerSms(), customerEmail()]);

  // Join the two message errors deterministically (SMS first, then email),
  // preserving the original "a; b" concatenation shape.
  const messageError =
    [smsError, emailError].filter(Boolean).join('; ') || undefined;
  const requestedChannels = isGhlRetry || quote.is_test
    ? []
    : [doSms ? 'sms' : null, doEmail ? 'email' : null].filter(
        (value): value is 'sms' | 'email' => value != null,
      );
  const failedChannels = requestedChannels.filter(
    (requested) => (requested === 'sms' ? !smsSent : !emailSent),
  );
  const deliveryAttempted = requestedChannels.length > 0;
  const everyRequestedDeliveryFailed =
    deliveryAttempted && failedChannels.length === requestedChannels.length;

  // The local sent stamp is an audit/idempotency record, not proof of delivery.
  // If every requested channel failed, return a real failure so the builder cannot
  // claim success. The response preserves locallySent=true and the exact failed
  // channels so the UI can offer a delivery-only retry without re-stamping or
  // moving the CRM card.
  if (everyRequestedDeliveryFailed) {
    return NextResponse.json(
      {
        ok: false,
        code: 'delivery-failed',
        error: messageError ?? 'No requested customer message was delivered.',
        locallySent: true,
        sentAt,
        smsSent,
        emailSent,
        failedChannels,
        channel,
        deliveryRetry: isDeliveryRetry,
      },
      { status: 502 },
    );
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
    deliveryRetry: isDeliveryRetry,
    ghlSynced: stageUpdated || (isDeliveryRetry && quote.ghl_stage_synced_at != null),
    smsSent,
    emailSent,
    messageError,
    failedChannels,
    // Task 10 — channel split: echo the resolved channel for observability.
    channel,
    // #116: flags a revive run (declined/lost → sent on the SAME quote) so
    // the operator UI can distinguish it from a fresh/first send.
    ...(isRevive ? { revived: true } : {}),
  });
}
