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
// #116 (re-send half): a DECLINED or ABANDONED quote is revivable — this route
//   treats it as a fresh send (re-stamp quote_sent_at + status='sent',
//   re-message the customer, re-advance the GHL card to Bid Sent) instead of
//   short-circuiting on the old quote_sent_at. CANCELLED stays excluded
//   (post-booking — refunds are manual, rebook-only). A revive with
//   deposit_paid_at already set is refused 409 (fail closed).
// Row 340: a revive reseeds the customer's portal from whatever
//   browsing_selection they last saved BEFORE declining/abandoning (ledger row
//   239's live-selection persist, widened to stay browsable post-decline by
//   row 236) — the operator previously had no visibility into this and no way
//   to reset it. Body accepts an optional
//   `clearBrowsingSelection: { expectedUpdatedAt: string | null }` (only
//   meaningful on a revive) to wipe that stale selection as part of THIS SAME
//   guarded stamp write, so the customer's portal reopens on the normal
//   staff-recommended default instead of picking back up where they left off
//   pre-decline. PipelineActionsMenu.tsx surfaces the stale selection (via
//   GET /api/pipeline/[quoteId]'s staleBrowsingSelection) and asks the
//   operator before sending this field. A no-op on any non-revive send.
//   Premerge fix round (row 340, technical+customer+admin MED, converged):
//   the customer's DECLINED/ABANDONED portal stays deliberately browsable
//   (row 236), so a fresh selection can land between the staff menu-open GET
//   and the send+clear click — a bare clear would silently destroy a
//   selection NEWER than the one the operator was shown. `expectedUpdatedAt`
//   is the `savedAt` the operator was shown; the clear only fires when the
//   row's CURRENT browsing_selection_updated_at (read by this same request's
//   own SELECT, below) still equals it. A mismatch SKIPS the clear (never the
//   send — the stamp write still proceeds) and the response's
//   `browsingSelectionClearSkipped: true` tells the operator their clear was
//   dropped because the selection changed under them. Deliberately NOT
//   guarded the other direction: a selection saved AFTER the clear commits is
//   fresh browsing, not stale, and legitimately wins. The clear also stamps
//   `approval_snapshot.browsingSelectionCleared = { by, at, packageId,
//   itemCount }`, mirroring staff-decline's `approval_snapshot.staffDeclined`
//   audit marker for the same class of operator-initiated destructive change.
// Response:
//   { ok: true, sentAt: ISO, stageUpdated: boolean, opportunityCreated: boolean,
//     opportunityId: string | null, stageError?: string, ghlRetry: boolean,
//     deliveryRetry: boolean, ghlSynced: boolean, eventDateSyncError?: string,
//     smsSent: boolean,
//     emailSent: boolean, messageError?: string, failedChannels: ('sms'|'email')[],
//     channel: 'sms' | 'email' | 'both', alreadySent?: boolean, revived?: true,
//     browsingSelectionClearSkipped?: true,
//     channelOutcomes?: { sms: ChannelOutcome | null, email: ChannelOutcome | null } }
//     — browsingSelectionClearSkipped (row 340 fix round) is present only when
//     the operator asked to clear the stale browsing selection and the TOCTOU
//     guard dropped it (see the route header) — the send itself still succeeded.
//     — eventDateSyncError (#237 FIX A) is present only for an EVENT quote
//     with a real event date and a linked contact: undefined means either
//     "not applicable" or "pushed fine," a string means the push to GHL's
//     "Event Date" custom field was attempted and failed (see
//     src/lib/integrations/ghlEventDate.ts).
//     — channelOutcomes is set ONLY on the alreadySent short-circuit (row 269;
//     both the fresh-send and retry-path hits of it share this one return
//     site — see below), a best-effort read of quote_deliveries
//     (fetchLatestDeliveryOutcomes, src/lib/quoteDeliveries.ts) telling the
//     caller which channel(s) actually confirmed delivery on the send that
//     made this quote "already sent" so a redeliver offer can be scoped to
//     only the channel(s) that didn't. ChannelOutcome = { outcome:
//     'sent'|'failed', error: string | null, at: ISO }; null for a channel
//     means no delivery attempt was ever recorded for it. The field is
//     omitted entirely (not present, not null) when the read itself fails —
//     distinct from a channel being null inside a present object.
//   { error: string, code?: string }  — no server state changed (empty-quote,
//     no-contact, view-only, deposit-paid, send-conflict, a stamp-write failure)
//   502 { ok: false, code: 'delivery-failed', error: string, locallySent: true,
//     sentAt: ISO, smsSent: boolean, emailSent: boolean,
//     failedChannels: ('sms'|'email')[], channel: 'sms' | 'email' | 'both',
//     deliveryRetry: boolean, stageUpdated: boolean, stageError?: string,
//     opportunityId: string | null, ghlSynced: boolean,
//     eventDateSyncError?: string } — every requested
//     customer channel failed, but the quote WAS stamped sent locally and the
//     GHL stage move (fresh send only — see stageUpdated/ghlSynced above) may
//     still have gone through (row 271).
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
import type { QuoteInputs } from '@/lib/pricing/pricingEngine';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  createOpportunity,
  updateOpportunity,
  findOpportunityForContact,
  resurrectDuplicateOpportunity,
  upsertContactCustomField,
  sendSms,
  sendEmail,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { resolvePipelineStages, quoteLinkFieldId, quoteLinkFieldEnvVar } from '@/lib/integrations/ghlPipelineMap';
import { pushEventDateToGhl, formatEventDateForGhl } from '@/lib/integrations/ghlEventDate';
import {
  quoteEmailSubject,
  quoteSmsBody,
  quoteEmailHtml,
} from '@/lib/integrations/quoteMessages';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { deriveStatus, canRevive } from '@/lib/quoteStatus';
import { attachQuoteToCustomer, propagateQuoteTagsToCustomer, quoteRowToIdentity } from '@/lib/customers';
import {
  logQuoteDelivery,
  DELIVERY_TIMEOUT_ERROR_PREFIX,
  fetchLatestDeliveryOutcomes,
} from '@/lib/quoteDeliveries';
import { queueQuoteBuildSessionCompletion } from '@/lib/quoteBuildTiming';
import { getDesignByQuote } from '@/lib/designs';
import {
  describeUnderBilledMiniGroups,
  findUnderBilledMiniGroups,
} from '@/lib/design/miniGroupBilledCheck';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #264: this route's own direct Supabase calls (the quote fetch, the
// quote_sent_at stamp, the opportunity-link write, the GHL sync-state write)
// previously had no timeout either — bounded with the same manual-
// AbortController idiom as ghlFetch (src/lib/integrations/highlevel.ts) and
// logQuoteDelivery (src/lib/quoteDeliveries.ts), for the same reason: a hung
// DB connection stalled the route indefinitely. 5s matches quoteDeliveries'
// own DB budget (see that file's comment for why DB gets a tighter bound than
// GHL's 10s). Deliberately scoped to code IN this route file — the shared
// find-or-create helpers tagPropagation calls into (src/lib/customers.ts) are
// multi-route library code, so they're bounded at the CALL SITE instead (a
// deadline race around the tagPropagation() call below), not edited directly.
// (#264 round 2 correction: round 1's "rarely runs, low priority" framing for
// that gap was wrong — prod data showed 149/182 sent quotes, 82%, carry
// legacy_rebook=true, so tagPropagation is the MAJORITY path, not an edge
// case. See TAG_PROPAGATION_DEADLINE_MS below.)
const SEND_ROUTE_DB_TIMEOUT_MS = 5_000;

// A retry owns its external side effects for two minutes. That comfortably
// exceeds this route's bounded GHL/message work, while a crashed invocation
// eventually becomes retryable instead of leaving the quote stuck forever.
const RETRY_CLAIM_WINDOW_MS = 2 * 60_000;

// A fresh send, resend, or revival performs both GHL and customer-delivery
// work. Its lifecycle stamp may therefore claim both effect slots only when
// neither is owned by another live request. PostgREST's `.or()` accepts this
// disjunctive normal form for `(delivery is free) AND (GHL is free)`.
function effectClaimsAvailableFilter(cutoff: string): string {
  return [
    'and(delivery_retry_claimed_at.is.null,ghl_retry_claimed_at.is.null)',
    `and(delivery_retry_claimed_at.is.null,ghl_retry_claimed_at.lt.${cutoff})`,
    `and(delivery_retry_claimed_at.lt.${cutoff},ghl_retry_claimed_at.is.null)`,
    `and(delivery_retry_claimed_at.lt.${cutoff},ghl_retry_claimed_at.lt.${cutoff})`,
  ].join(',');
}

// postgrest-js query builders are only PromiseLike (a bare `.then()`, no
// `.catch()`/`.finally()` — confirmed by reading PostgrestBuilder's own class
// declaration), so the timer can't be cleared with a `.finally()` chained
// directly onto the query. This wraps a builder-producing callback (called
// with the AbortSignal to attach via `.abortSignal(signal)`) and clears the
// timer off a REAL Promise instead. Keeps every call site a single
// destructured `const`, matching the surrounding style.
function withDbTimeout<T>(build: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_ROUTE_DB_TIMEOUT_MS);
  return Promise.resolve(build(controller.signal)).finally(() => clearTimeout(timer));
}

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

// #264 honesty nuance: quote_deliveries.outcome is a binary CHECK constraint
// ('sent' | 'failed' — see migrations/2026-08-12-quote-deliveries.sql), so an
// outcome-unknown send still has to log as 'failed' (the conservative choice
// — it offers a delivery retry rather than silently trusting an unconfirmed
// send). But an outcome-unknown failure is NOT a confirmed rejection: GHL may
// have already received and even fully processed the request before we lost
// the ability to read its response, so the error text must say the outcome
// is unknown rather than reading like a confirmed failure. The "timeout — "
// lead is DELIVERY_TIMEOUT_ERROR_PREFIX (src/lib/quoteDeliveries.ts) — the
// one exported constant a future reporting query matches on, not a private
// literal duplicated here (kept as the literal string despite the name no
// longer being timeout-exclusive — see that constant's own comment).
//
// Row 269 fix round 2 (delta-verify HIGH): round 1 keyed this hedge off
// HighLevelError#timedOut alone — set ONLY by ghlFetch's own abort branch
// (src/lib/integrations/highlevel.ts), which fires when OUR controller aborts
// the request after GHL_TIMEOUT_MS. That left a real gap: ghlFetch's outer
// `catch (err) { if (controller.signal.aborted) throw timeoutError(...); throw
// err; }` rethrows ANY other connect-phase failure (a socket reset, DNS
// failure, connection refused — all of these can happen well inside the 10s
// budget, with no abort involved) as a raw, non-timedOut error. That raw
// error was being read as a CONFIRMED failure — round 1 downgraded the
// redeliver dialog to a plain window.confirm for exactly that "confirmed"
// case, which meant a genuine socket-reset-after-GHL-accepted-the-send could
// get a low-friction redeliver click and a real duplicate customer message.
//
// The fix: the discriminator is now "did we receive a definitive answer from
// GHL?", not "was this our own timeout?". We only have a definitive answer
// when GHL actually returned an HTTP response — i.e. a HighLevelError
// carrying a numeric `status` (set on ghlFetch's `!res.ok` path, and also by
// the one other status-bearing throw in this codebase, the 409 "active
// opportunity" conflict in resurrectDuplicateOpportunity — which correctly
// stays unhedged too: that status is derived from a SUCCESSFUL GHL response
// to a real GET, not a network ambiguity). Everything else — our own abort,
// a socket reset, DNS failure, connection refused, or any other error that
// isn't a status-bearing HighLevelError — never produced a definitive
// outcome and is hedged. This deliberately over-hedges connection-refused
// cases that structurally could never have reached GHL at all; that's the
// correct direction (one extra operator keystroke vs. a real duplicate
// customer message).
//
// #264 round 2, FIX 7: the identical ambiguity applies to a GHL STAGE move
// whose true outcome is unknown (updateOpportunity/createOpportunity/etc.
// inside ghlStageChain below) — the card may have already advanced before we
// lost the ability to confirm it — so stageError gets the same hedge, via
// this one parameterized helper rather than a near-duplicate third function.
// stageError's home (quotes.ghl_sync_error) is free text with no CHECK
// constraint forcing a binary read, unlike quote_deliveries.outcome, but the
// honesty reasoning — don't let an unconfirmed outcome read like a confirmed
// rejection — is the same either way.
function timeoutHedgedErrorMessage(err: unknown, whatsUnknown: string, mayHaveAlready: string): string {
  const message = hlErrorMessage(err);
  const definitiveGhlResponse = err instanceof HighLevelError && typeof err.status === 'number';
  return !definitiveGhlResponse
    ? `${DELIVERY_TIMEOUT_ERROR_PREFIX}${whatsUnknown} outcome unknown (GHL may have ${mayHaveAlready}): ${message}`
    : message;
}

function deliveryErrorMessage(err: unknown): string {
  return timeoutHedgedErrorMessage(err, 'delivery', 'still delivered it');
}

function stageErrorMessage(err: unknown): string {
  return timeoutHedgedErrorMessage(err, 'stage', 'already advanced the card');
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
  // NCE tag (#198): no pipeline/routing behavior of its own — read here only
  // for the tag-propagation block below.
  is_nce: boolean;
  // View-only portal (#176): a staff-flagged browse-only quote can never be
  // sent — see the check right after the fetch below. A real send would
  // reuse/overwrite the contact's GHL opportunity card and re-stamp their
  // quote-link field with the browse-only portal URL, so this must run
  // before any messaging or GHL work, not just before the DB stamp.
  view_only: boolean;
  // #198 tag propagation: the linked customer (if any) + the raw identity
  // columns, so an unlinked-but-tagged quote can be (re-)attached at send
  // time using whatever contact info has accumulated on the row by now (a
  // self-serve-estimate quote starts address-only; name/email/phone can land
  // later via a path that never re-runs attachQuoteToCustomer).
  customer_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  // Event-date GHL push (#237): only column read here is inputs.event.eventDate
  // (an ISO yyyy-mm-dd string, staff-entered on EventSection — see
  // src/lib/event/types.ts's EventInputFields). Not selected before this row;
  // added specifically for the event-date push below.
  inputs: QuoteInputs | null;
  // Row 340 fix round: the CAS + audit-stamp source for a revive's optional
  // browsing-selection clear (see the route header). browsing_selection_updated_at
  // is the version this request's clear is checked against;  browsing_selection
  // itself supplies the packageId/itemCount recorded in the audit marker.
  browsing_selection: { packageId?: unknown; selectedItemIds?: unknown } | null;
  browsing_selection_updated_at: string | null;
  // Audit marker column (mirrors staff-decline's approval_snapshot.staffDeclined) —
  // spread-preserved so a browsing-selection-clear stamp never clobbers an
  // existing snapshot entry.
  approval_snapshot: Record<string, unknown> | null;
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
  // Default is 'both' for callers that omit channel (including older clients).
  // Guard against a double-read: the body is only ever read once here.
  // Row 340: also accepts `clearBrowsingSelection?: { expectedUpdatedAt: string | null }`
  // — see the route header. Read here (not deferred to the isRevive branch
  // below) so both fields come from the ONE body read.
  let sendBody: { channel?: unknown; clearBrowsingSelection?: unknown; quoteBuildTimerId?: unknown } = {};
  try { sendBody = await req.json(); } catch { sendBody = {}; }
  const channel = (sendBody.channel === 'sms' || sendBody.channel === 'email' || sendBody.channel === 'both')
    ? sendBody.channel
    : 'both';
  const clearBrowsingSelectionReq = (() => {
    const raw = sendBody.clearBrowsingSelection;
    if (!raw || typeof raw !== 'object') return null;
    const expected = (raw as Record<string, unknown>).expectedUpdatedAt;
    if (expected !== null && typeof expected !== 'string') return null;
    return { expectedUpdatedAt: expected as string | null };
  })();
  const doSms   = channel === 'both' || channel === 'sms';
  const doEmail = channel === 'both' || channel === 'email';
  const quoteBuildTimerId =
    typeof sendBody.quoteBuildTimerId === 'string' && UUID_RE.test(sendBody.quoteBuildTimerId)
      ? sendBody.quoteBuildTimerId
      : null;

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await withDbTimeout((signal) =>
    sb
      .from('quotes')
      .select('id, highlevel_opportunity_id, highlevel_contact_id, customer_name, service_type, total, result, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, status, ghl_stage_synced_at, is_test, legacy_rebook, is_nce, view_only, customer_id, customer_email, customer_phone, customer_address, inputs, browsing_selection, browsing_selection_updated_at, approval_snapshot')
      .eq('id', id)
      .abortSignal(signal)
      .single<QuoteRow>(),
  );

  if (fetchErr || !quote) {
    return NextResponse.json(
      { error: `Quote not found: ${fetchErr?.message ?? 'no row'}` },
      { status: 404 },
    );
  }

  // View-only portal (#176): a staff-flagged browse-only quote can never be
  // sent — checked before ANY of the logic below (idempotency short-circuit,
  // the quote_sent_at stamp, the GHL stage chain, customer messaging). A send
  // would reuse/overwrite the contact's real open GHL opportunity card and
  // re-stamp their quote-link custom field with the browse-only portal URL.
  if (quote.view_only) {
    return NextResponse.json(
      { error: 'This quote is view-only', code: 'view-only' },
      { status: 409 },
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
  // #116 (re-send half): declined/abandoned are REVIVABLE — the operator re-sends
  // the SAME quote instead of rebooking a new draft. Deliberately a scoped
  // bypass here (canRevive), NOT a widened ALLOWED_TRANSITIONS entry — see
  // quoteStatus.ts. 'cancelled' is excluded (post-booking; refunds are
  // manual, rebook-only).
  const isRevive = canRevive(currentStatus);
  const isFirstSend = quote.quote_sent_at == null && !isResend && !isRevive;

  // Ledger row 434, Naldo's call 2026-08-27. A mini light group is priced from
  // the count staff TYPE on it, never from how many members are drawn, and that
  // is deliberate (row 334: summing over-bills the common case). Row 872 then
  // let staff add members without that count changing, and the editor warns when
  // the two diverge. This is the net for a missed warning: refuse a FIRST send
  // that would under-bill, until staff confirm.
  //
  // Scope, deliberately narrow:
  //   - only UNDER-billing (drawn > billed). Billing more than is drawn is a
  //     normal staff judgement and is not money at risk.
  //   - only a first send. A resend or revive is not the moment to relitigate
  //     counts on a quote the customer has already seen.
  //   - a CONFIRM, not a block. A group can legitimately bill fewer strings
  //     than it has drawn segments.
  // This is NOT a customer-accuracy check: the drawn design is a reference, not
  // a promise of exact placement, so a mismatch is not something the customer is
  // owed. It exists so YLL does not silently under-charge for work it performs.
  if (isFirstSend && !quote.is_test && req.headers.get('x-confirm-underbilled') !== 'yes') {
    try {
      const design = await getDesignByQuote(id);
      const underBilled = findUnderBilledMiniGroups(design?.scene ?? null);
      if (underBilled.length > 0) {
        return NextResponse.json(
          {
            error: describeUnderBilledMiniGroups(underBilled),
            code: 'underbilled-mini-groups',
            groups: underBilled,
          },
          { status: 428 }, // Precondition Required, same idiom as the booked-delete confirm
        );
      }
    } catch (err) {
      // Best effort by design. This is a courtesy check on staff's own billing,
      // so a design-load failure must never block a send the operator asked for.
      console.warn('[quotes/:id/send] under-billed mini-group check failed:', err);
    }
  }

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
    // Row 269: tell the caller WHICH channel(s) actually confirmed delivery
    // on the send that made this quote "already sent" — without this, the
    // UI has zero information and (before this fix) defaulted to offering a
    // blind 'both' redeliver, which could re-fire a channel that already
    // succeeded (GHL's /conversations/messages has no idempotency key of its
    // own, so that's a REAL duplicate text/email, not just a wasted click).
    // Best-effort: fetchLatestDeliveryOutcomes never throws and returns null
    // on any failure, in which case channelOutcomes is simply omitted below
    // and the caller falls back to today's behavior.
    const channelOutcomes = await fetchLatestDeliveryOutcomes(id);
    return NextResponse.json({
      ok: true,
      sentAt: quote.quote_sent_at,
      stageUpdated: false,
      alreadySent: true,
      ...(channelOutcomes ? { channelOutcomes } : {}),
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

  // Every provider-effecting path holds the relevant short-lived claim until
  // its work settles. Retries acquire one here; fresh sends, resends, and
  // revivals write both claims atomically with their sent stamp below. That
  // makes a retry conflict with an in-flight initial send instead of reaching
  // the same customer or GHL card alongside it.
  const effectClaims: Array<{
    column: 'delivery_retry_claimed_at' | 'ghl_retry_claimed_at';
    claimedAt: string;
  }> = [];
  const retryClaimColumn = isGhlRetry
    ? 'ghl_retry_claimed_at'
    : isDeliveryRetry
      ? 'delivery_retry_claimed_at'
      : null;
  const retryClaimAt = retryClaimColumn ? new Date().toISOString() : null;
  if (retryClaimColumn && retryClaimAt) {
    const retryClaimCutoff = new Date(Date.now() - RETRY_CLAIM_WINDOW_MS).toISOString();
    try {
      const { data: claimRows, error: claimErr } = await withDbTimeout((signal) => {
        let claimQuery = sb
          .from('quotes')
          .update({ [retryClaimColumn]: retryClaimAt })
          .eq('id', id)
          .eq('quote_sent_at', quote.quote_sent_at)
          .eq('view_only', false)
          .is('customer_approved_at', null)
          .is('deposit_paid_at', null)
          .or(`${retryClaimColumn}.is.null,${retryClaimColumn}.lt.${retryClaimCutoff}`);
        claimQuery = quote.status == null
          ? claimQuery.is('status', null)
          : claimQuery.eq('status', quote.status);
        if (isGhlRetry) claimQuery = claimQuery.is('ghl_stage_synced_at', null);
        return claimQuery.select('id').abortSignal(signal);
      });
      if (claimErr) {
        console.error('[api/quotes/:id/send] retry claim failed:', claimErr);
        return NextResponse.json(
          { error: `Failed to claim retry: ${claimErr.message}` },
          { status: 500 },
        );
      }
      if (!claimRows || claimRows.length === 0) {
        return NextResponse.json(
          { error: 'This quote changed before it could be sent — please refresh and try again.', code: 'send-conflict' },
          { status: 409 },
        );
      }
      effectClaims.push({ column: retryClaimColumn, claimedAt: retryClaimAt });
    } catch (error) {
      console.error('[api/quotes/:id/send] retry claim failed:', error);
      return NextResponse.json({ error: 'Failed to claim retry' }, { status: 500 });
    }
  }

  // On a GHL-only retry the quote keeps its original sent timestamp.
  // On a resend (changes_requested → sent) or a revive (declined/abandoned → sent)
  // we re-stamp with the current time so the audit trail reflects when the
  // quote was (re-)delivered.
  const sentAt = ((isGhlRetry || isDeliveryRetry) && !isResend)
    ? (quote.quote_sent_at ?? new Date().toISOString())
    : new Date().toISOString();

  // Row 340 fix round: true only when the operator asked to clear the stale
  // browsing selection AND that ask was dropped because the row's
  // browsing_selection_updated_at no longer matched what they were shown —
  // surfaced in the response so the operator knows the selection is still
  // there (see the route header + stampPayload construction below).
  let browsingSelectionClearSkipped = false;

  // Stamp the DB FIRST (fresh send only), before the HL call, so we don't
  // double-fire the stage move on retries. Same pattern as /approve.
  if (!isGhlRetry && !isDeliveryRetry) {
    // Advance the explicit lifecycle status alongside the timestamp (ledger
    // #83). quote_sent_at stays the idempotency key; status mirrors it so the
    // explicit-status read path agrees with deriveStatus().
    const initialClaimAt = new Date().toISOString();
    const initialClaimCutoff = new Date(Date.now() - RETRY_CLAIM_WINDOW_MS).toISOString();
    const stampPayload: Record<string, unknown> = {
      quote_sent_at: sentAt,
      status: 'sent',
      delivery_retry_claimed_at: initialClaimAt,
      ghl_retry_claimed_at: initialClaimAt,
    };
    if (isRevive) {
      // #116: force deriveStatus to read 'sent' the moment this row is next
      // loaded. deriveStatus only trusts a persisted status for the
      // declined/cancelled/abandoned/changes_requested branch states — NOT 'sent'
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
      // Row 340: an explicit operator choice (surfaced from the pipeline
      // menu's pre-send prompt, see the route header) to wipe the stale
      // pre-decline browsing selection as part of THIS SAME guarded write —
      // never a default, and never touched on a non-revive send (the
      // ordinary browsing-selection route already refuses to write over an
      // approval, and a live sent/viewed quote's selection is real,
      // in-progress customer data this route has no business clearing).
      //
      // Premerge fix round (row 340, technical+customer+admin MED, converged
      // TOCTOU): the operator's choice was made against the `savedAt` GET
      // /api/pipeline/[quoteId] showed them at menu-open time, which can be
      // stale by the time this request lands — the portal stays browsable
      // post-decline (row 236), so the customer can save a NEW selection in
      // that window. `expectedUpdatedAt` is that shown `savedAt`; the clear
      // only fires when the row's CURRENT browsing_selection_updated_at
      // (read by this request's own SELECT above, so as fresh as this route
      // ever gets) still matches. A mismatch skips the clear — never the
      // send — and browsingSelectionClearSkipped tells the operator why.
      // Deliberately NOT guarded the other direction: a selection saved
      // AFTER this clear commits is fresh browsing, not stale, and
      // legitimately wins.
      //
      // Precision, so nobody later reads this as more than it is (S46
      // delta-verify): the compare is JS-side against the value THIS
      // request SELECTed — it is NOT an atomic DB compare-and-swap, and
      // the stamp UPDATE below carries no .eq() on this column. It NARROWS
      // the race from minutes (staff menu-open GET -> click) to the few ms
      // between this route's own SELECT and its UPDATE; it does not close
      // it. A real CAS would have to condition the single combined stamp
      // write on this column, which on a mismatch would fail the whole
      // write and so block the SEND — the opposite of the intended "skip
      // the clear, never the send".
      if (clearBrowsingSelectionReq) {
        const shownUpdatedAt = clearBrowsingSelectionReq.expectedUpdatedAt;
        const currentUpdatedAt = quote.browsing_selection_updated_at ?? null;
        if (currentUpdatedAt === shownUpdatedAt) {
          stampPayload.browsing_selection = null;
          stampPayload.browsing_selection_updated_at = null;
          // Audit trace (admin MED): mirrors staff-decline's
          // approval_snapshot.staffDeclined marker for the same class of
          // operator-initiated destructive change. packageId/itemCount only
          // — never serialize the whole selection into the audit trail.
          const operator = await getOperator();
          const rawSelection = quote.browsing_selection;
          stampPayload.approval_snapshot = {
            ...(quote.approval_snapshot ?? {}),
            browsingSelectionCleared: {
              by: operator?.email ?? null,
              at: sentAt,
              packageId: typeof rawSelection?.packageId === 'string' ? rawSelection.packageId : null,
              itemCount: Array.isArray(rawSelection?.selectedItemIds) ? rawSelection.selectedItemIds.length : 0,
            },
          };
        } else {
          browsingSelectionClearSkipped = true;
        }
      }
    }
    // #187b TOCTOU: the view_only check above (and the deposit_paid_at check
    // baked into isRevive's 409 above) are fast-path reads — staff could flip
    // view_only ON, or the deposit could get paid, between that read and this
    // write. Re-assert both directly on the write, mirroring the sibling
    // `.eq('view_only', false)` idiom (approve/decline/pay/request-changes/
    // staff-approve). `.is('deposit_paid_at', null)` additionally guards a
    // revive-stamp from clobbering customer_approved_at/viewed_at on a quote
    // that's now paid.
    //
    // A first send claims quote_sent_at IS NULL atomically. Resends and
    // revivals already have a sent timestamp, so they instead claim the exact
    // lifecycle status read above. Either way, only one update can still
    // match; the loser returns the existing send-conflict below before any GHL
    // or customer-delivery work. `.select('id')` reports whether we won.
    const { data: stampedRows, error: stampErr } = await withDbTimeout((signal) => {
      let stampQuery = sb
        .from('quotes')
        .update(stampPayload)
        .eq('id', id)
        .eq('view_only', false)
        .is('deposit_paid_at', null)
        .or(effectClaimsAvailableFilter(initialClaimCutoff));
      stampQuery = (isResend || isRevive)
        ? stampQuery.eq('status', currentStatus)
        : stampQuery.is('quote_sent_at', null);
      return stampQuery
        .select('id')
        .abortSignal(signal);
    });
    if (stampErr) {
      console.error('[api/quotes/:id/send] stamp failed:', stampErr);
      return NextResponse.json(
        { error: `Failed to mark quote sent: ${stampErr.message}` },
        { status: 500 },
      );
    }
    // Lost the race (0 rows): the quote changed out from under us — mirrors
    // decline/request-changes' undisambiguated 409 (the write guards multiple
    // conditions at once; no single label is more truthful than another).
    if (!stampedRows || stampedRows.length === 0) {
      return NextResponse.json(
        { error: 'This quote changed before it could be sent — please refresh and try again.', code: 'send-conflict' },
        { status: 409 },
      );
    }
    effectClaims.push(
      { column: 'delivery_retry_claimed_at', claimedAt: initialClaimAt },
      { column: 'ghl_retry_claimed_at', claimedAt: initialClaimAt },
    );

    // NCE + YLL Neighbor tag propagation (#198): moved into the delivery
    // Promise.allSettled group below (review fix, customer MED, S34 #198
    // review) — see the tagPropagation closure's own comment for why.
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
  // FIX A (#237 fix round, staff-lens HIGH) — see the event-date push block
  // below (inside ghlStageChain) for the full reasoning. Undefined = no
  // problem (or nothing was attempted); a string = the push was attempted
  // (a real event date existed) and pushEventDateToGhl reported pushed:false.
  let eventDateSyncError: string | undefined;
  // #314 fix round (staff-lens HIGH): set only when this push actually
  // succeeded, to the exact MM/DD/YYYY value pushed — stamped onto
  // quotes.ghl_event_date_pushed below (same write as the stage-sync
  // persist) so the approval-time reconcile (and any future save) can tell
  // "our date changed since we last confirmed a push" from "GHL currently
  // disagrees with us." See ghlEventDate.ts's migration comment / the
  // approve route's own #314 comment for the full reasoning.
  let eventDatePushedValue: string | undefined;

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
            stageError = stageErrorMessage(err);
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
                // #172: contact already has a card and GHL forbids a second one.
                // Shared resurrect (one implementation with the attach path):
                // inspects the card first — refuses to touch an OPEN one — then
                // reopens it at Bid Sent with our title/value.
                const revived = await resurrectDuplicateOpportunity(createErr, {
                  pipelineId: stages.pipelineId,
                  pipelineStageId: stages.sent,
                  name: cardName,
                  monetaryValue,
                });
                if (!revived) throw createErr;
                opportunityId = revived.id;
              }
            }
            stageUpdated = true;
            // Persist the resolved card id so future send/approve calls find it.
            const { error: linkErr } = await withDbTimeout((signal) =>
              sb
                .from('quotes')
                .update({ highlevel_opportunity_id: opportunityId })
                .eq('id', id)
                .abortSignal(signal),
            );
            if (linkErr) {
              console.warn('[api/quotes/:id/send] failed to relink opportunity id:', linkErr.message);
            }
          } catch (err) {
            console.warn('[api/quotes/:id/send] find-or-create opportunity failed:', err);
            stageError = stageErrorMessage(err);
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

    // Event-date GHL push (#237): mirror an EVENT quote's staff-entered event
    // date onto its linked contact's "Event Date" custom field — see
    // src/lib/integrations/ghlEventDate.ts for the find-or-create-by-name
    // resolution (1:1 with ghlTenure.ts) and the MM/DD/YYYY format decision.
    //
    // Positive service-type gate (never `!== 'permanent'`, per this repo's
    // standing rule) — a negative gate would silently push a garbage/blank
    // value for every future non-event vertical instead of a clean no-op.
    //
    // Deliberately NOT gated on `stageUpdated` (unlike the quote-link stamp
    // just above): the event date is independent contact metadata, not tied
    // to the portal URL a card move stamps — a customer should still get
    // their event date recorded on the CRM contact even if the pipeline card
    // move itself failed (e.g. a transient GHL error on that one call). Still
    // gated on `!quote.is_test` (never touch a real GHL contact for a
    // simulated send) and a linked contact.
    //
    // Placement (answers ledger #237 open question (b), "should it also fire
    // on ?retryDelivery"): inside ghlStageChain, which already returns
    // immediately at the top of this closure when `isDeliveryRetry` — so a
    // delivery-only retry (no CRM card move, no re-stamp) also skips this
    // push, exactly like the rest of the CRM-write chain. A `?retryGhl`
    // reconcile does reach this line and re-pushes the same value again,
    // which is harmless (a plain overwrite, not an append) — and, per the
    // FIX A comment below, is also how the operator's "Retry CRM sync"
    // button recovers from a failed push, not just a failed stage move.
    //
    // No try/catch: pushEventDateToGhl is documented AND actually
    // implemented (read ghlEventDate.ts) to never throw — every internal
    // failure (missing scope, a GHL error, the deadline) is caught inside
    // and resolves { pushed: false }. A prior version of this comment called
    // a wrapping try/catch here "defense-in-depth, mirroring every
    // pushTenureYearsToGhl call site" — false on inspection: grep every real
    // pushTenureYearsToGhl call site (tenure-years/route.ts, the Valor
    // webhook, convert-to-job, simulate-deposit) and every one of them calls
    // it bare, unwrapped, for the exact same never-throws reason. The dead
    // catch here could never execute; removed instead of kept mislabeled.
    //
    // FIX A (#237 fix round, staff-lens HIGH): the outcome used to be
    // discarded here entirely — `pushEventDateToGhl(...)` was called for its
    // side effect only, its `{ pushed }` return value never read — so a
    // missing Custom Fields scope, a GHL 500, or the 6s deadline tripping
    // left the operator seeing a clean "✓ Sent" with zero indication the
    // date never reached the CRM. eventDateSyncError (declared with
    // stageError above) now carries that outcome to the JSON response,
    // mirroring stageError/ghlSynced's existing shape — see
    // QuoteBuilder.tsx's eventDateSyncWarning state + banner, which reuses
    // the SAME "Retry CRM sync" button as the stage-move warning (that
    // retry re-runs this whole chain, including this push) rather than
    // inventing a new retry path. Kept as a SEPARATE banner from the
    // existing one rather than folded into it: that banner's copy explicitly
    // claims "the HighLevel card didn't advance to Bid Sent," which would be
    // a false claim on a send where the card moved fine and only this push
    // failed.
    //
    // Only a date that was actually worth pushing counts as an "attempt" to
    // report on — formatEventDateForGhl mirrors the no-op check
    // pushEventDateToGhlInner runs internally, so a blank/malformed date
    // (the deliberate "quietly do nothing" case a few lines up) never
    // manufactures a false warning; it only means there's nothing to warn
    // about.
    const formattedEventDateForPush = formatEventDateForGhl(quote.inputs?.event?.eventDate);
    if (
      quote.service_type === 'event' &&
      !quote.is_test &&
      quote.highlevel_contact_id &&
      formattedEventDateForPush
    ) {
      const { pushed } = await pushEventDateToGhl(quote.highlevel_contact_id, quote.inputs?.event?.eventDate);
      if (!pushed) {
        eventDateSyncError =
          'The event date may not have synced to HighLevel — check the CRM contact, or retry below.';
      } else {
        // #314 fix round: record the CONFIRMED value so the syncPayload
        // write below can stamp quotes.ghl_event_date_pushed.
        eventDatePushedValue = formattedEventDateForPush;
      }
    }

    // Audit fix (send-route-ghl-sync-state, finding #32): persist the stage-sync
    // OUTCOME durably so a card that never advanced is discoverable + retryable,
    // instead of leaving the only trace in a console line. On success clear the
    // error and stamp ghl_stage_synced_at; on failure record the reason and leave
    // ghl_stage_synced_at NULL (the ?retryGhl reconcile bucket). This write is
    // itself best-effort — its failure only logs, never undoes the send.
    const syncPayload = {
      ...(quote.is_test || stageUpdated
        ? { ghl_stage_synced_at: new Date().toISOString(), ghl_sync_error: null }
        : { ghl_sync_error: stageError ?? 'GHL stage not synced' }),
      // #314 fix round: only present when this send actually confirmed a
      // push — never overwrites the marker with something on a skip/failure.
      ...(eventDatePushedValue ? { ghl_event_date_pushed: eventDatePushedValue } : {}),
    };
    const { error: syncErr } = await withDbTimeout((signal) =>
      sb.from('quotes').update(syncPayload).eq('id', id).abortSignal(signal),
    );
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
    let result: Awaited<ReturnType<typeof sendSms>> | undefined;
    try {
      result = await sendSms({
        contactId: quote.highlevel_contact_id,
        message: quoteSmsBody(firstName, portalUrl, quote.service_type),
        fromNumber,
      });
      smsSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send] SMS send failed:', err);
      smsError = deliveryErrorMessage(err);
    }
    // #250: durable delivery record, written AFTER smsSent/smsError are final
    // so a logging hiccup can never influence the send outcome itself — see
    // logQuoteDelivery's own try/catch for the second layer of isolation.
    await logQuoteDelivery({
      quoteId: id,
      channel: 'sms',
      outcome: smsSent ? 'sent' : 'failed',
      providerMessageId: result?.messageId ?? null,
      error: smsSent ? null : (smsError ?? null),
    });
  };

  const customerEmail = async () => {
    if (!canMessage || !doEmail || !quote.highlevel_contact_id) return;
    let result: Awaited<ReturnType<typeof sendEmail>> | undefined;
    try {
      result = await sendEmail({
        contactId: quote.highlevel_contact_id,
        subject: quoteEmailSubject(quote.service_type),
        html: quoteEmailHtml(firstName, portalUrl, quote.service_type),
        emailFrom,
      });
      emailSent = true;
    } catch (err) {
      console.warn('[api/quotes/:id/send] Email send failed:', err);
      emailError = deliveryErrorMessage(err);
    }
    // #250: durable delivery record — see customerSms above for why this is
    // written after the outcome is final.
    await logQuoteDelivery({
      quoteId: id,
      channel: 'email',
      outcome: emailSent ? 'sent' : 'failed',
      providerMessageId: result?.messageId ?? null,
      error: emailSent ? null : (emailError ?? null),
    });
  };

  // NCE + YLL Neighbor tag propagation (#198): a tagged quote auto-tags its
  // customer the moment it BECOMES sent. Runs concurrently with the GHL
  // stage move + customer messaging above (review fix, customer MED, S34
  // #198 review) — this closure can do up to ~5 unbounded DB round trips
  // (attachQuoteToCustomer's find-or-create-customer + find-or-create-
  // property + relink, then propagateQuoteTagsToCustomer's update), which
  // used to run SERIALLY between the sent-stamp and the Promise.allSettled
  // group below — adding straight latency in front of the customer's SMS/
  // email instead of alongside it. Only runs on a fresh stamp (mirrors the
  // stamp block's own guard above — a retry never re-fires it, and it's
  // idempotent even if it did) and never for a TEST quote (admin HIGH review
  // fix — attachQuoteToCustomer must never run with test data; see the
  // AGENTS.md-style rationale that used to sit above the old inline block,
  // now folded into this guard).
  const tagPropagation = async () => {
    if (isGhlRetry || isDeliveryRetry) return;
    if (quote.is_test || (!quote.legacy_rebook && !quote.is_nce)) return;
    try {
      // #214 (verify-or-reattach): ALWAYS re-resolve through
      // attachQuoteToCustomer before propagating — quotes.customer_id is a
      // cache of a past findOrCreateCustomer decision, and an identity edit
      // since then can leave it pointing at the WRONG customer (the S34
      // wrap's 3-HIGH seam). Re-running is idempotent (an unchanged identity
      // re-resolves to the same row), heals the self-serve gap the old
      // lazy-attach existed for (an address-only quote whose name/email/
      // phone landed after save), fires the #700 hl heal, and re-links the
      // quote row when the resolution moved. The cached id is only the
      // FALLBACK — used when re-resolution can't produce an answer (identity
      // -less quote, transient DB error), where propagating to the last
      // known link beats silently dropping the tag. quoteRowToIdentity
      // translates the row's 'Anonymous'/'(no address)' display sentinels
      // back to null so they can never become identity evidence.
      const resolved = await attachQuoteToCustomer(
        quoteRowToIdentity({
          id,
          highlevel_contact_id: quote.highlevel_contact_id,
          customer_name: quote.customer_name,
          customer_email: quote.customer_email,
          customer_phone: quote.customer_phone,
          customer_address: quote.customer_address,
        }),
      );
      // Repoint visibility (#214 review, WT-55 family): a send-time
      // re-resolution that moved the quote off its cached row is loud.
      if (resolved && quote.customer_id && resolved.customerId !== quote.customer_id) {
        console.warn(
          `[api/quotes/:id/send] #214 repoint: quote ${id} customer_id ${quote.customer_id} → ${resolved.customerId} at send time. Review for a manual merge (WT-55).`,
        );
      }
      const linkedCustomerId = resolved?.customerId ?? quote.customer_id ?? null;
      if (linkedCustomerId) {
        await propagateQuoteTagsToCustomer(linkedCustomerId, {
          isNce: quote.is_nce,
          isYllNeighbor: quote.legacy_rebook,
        });
      }
    } catch (err) {
      console.warn('[api/quotes/:id/send] tag propagation failed (non-fatal):', err);
    }
  };

  if (isFirstSend && !quote.is_test) {
    queueQuoteBuildSessionCompletion({ quoteId: id, timerId: quoteBuildTimerId, sentAt });
  }

  // #264 round 2, FIX 1 (HIGH): tagPropagation is NOT the rare path round 1's
  // brief assumed — prod: 149/182 sent quotes (82%) carry legacy_rebook=true,
  // +5 more via is_nce, so this closure's ~5+ unbounded DB round trips
  // (findOrCreateCustomer + findOrCreateProperty + the hl_contact_id heal +
  // the quotes relink, then propagateQuoteTagsToCustomer's update — all in
  // src/lib/customers.ts) sit in the MAJORITY of real sends. Promise.allSettled
  // below waits for every task to SETTLE, not just avoid propagating a
  // rejection — a hang in this one task (customers.ts is shared multi-route
  // infra, so it isn't bounded directly, same reasoning as round 1) still
  // stalls the whole response even after the customer's SMS/email already
  // delivered, exactly the failure #264 exists to kill.
  //
  // Bounded here with a deadline race instead (mirrors ghlTenure.ts's
  // PUSH_DEADLINE_MS Promise.race exactly, including clearing the timer in
  // finally regardless of which side wins).
  //
  // 15s, not this route's 5s per-DB-call figure: that 5s is a per-call FAILURE
  // ceiling on a call that's normally sub-second, not a typical duration — so
  // it doesn't multiply linearly across tagPropagation's ~5-8 sequential calls
  // (5s × 8 would be 40s, which defeats the point of a "still respond in
  // reasonable time" deadline). 15s is roughly 3x a single call's ceiling:
  // generous enough that a couple of individually slow-but-not-hung calls in
  // the chain still finish inside budget, while still bounding the genuine
  // hang this fix targets to a fixed ceiling instead of leaving it unbounded.
  //
  // HONESTY: Promise.race does not cancel the loser. A raced-out
  // tagPropagation() keeps running in the background after this route has
  // already responded, and may still complete — the identical tradeoff
  // ghlTenure.ts's own PUSH_DEADLINE_MS documents for the same reason. Verified
  // safe here specifically: findOrCreateCustomer is explicitly race-safe
  // (UNIQUE-constraint retry-recovery, see its own #213 comments) and
  // deterministic (the same identity always resolves to the same row);
  // findOrCreateProperty is documented "Idempotent + race-safe via
  // UNIQUE(customer_id, address_key)"; the hl_contact_id heal only writes when
  // the column is CURRENTLY null (`.is('hl_contact_id', null)` — a no-op once
  // already set); and propagateQuoteTagsToCustomer only ever SETS is_nce/
  // is_yll_neighbor to true, never clears — a late background write lands the
  // same tags a retried send would have produced anyway. No customer-facing
  // side effect (no message, no GHL card move) is gated on this task, so a
  // late finish is invisible to the customer and, ordinarily, to the
  // operator — the quotes.customer_id/property_id relink is the one write in
  // this chain that isn't purely additive; it's deterministic given a stable
  // identity, but a background completion COULD overwrite a customer_id an
  // admin manually changed in the narrow window before it lands (a
  // pre-existing race this fix doesn't introduce — tagPropagation already ran
  // fully unbounded before this change — but now that race window can extend
  // past the HTTP response too; noted as residual risk in the report).
  const TAG_PROPAGATION_DEADLINE_MS = 15_000;
  const tagPropagationRaced = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(
          `[api/quotes/:id/send] tag propagation exceeded ${TAG_PROPAGATION_DEADLINE_MS}ms — responding without it; it may still complete in the background (see FIX 1's comment above for why that's safe).`,
        );
        resolve();
      }, TAG_PROPAGATION_DEADLINE_MS);
    });
    try {
      await Promise.race([tagPropagation(), deadline]);
    } finally {
      clearTimeout(timer!);
    }
  };

  // #264 round 2: the allSettled batch's bounded worst case is now roughly
  // ghlStageChain's ~5 sequential GHL calls at 10s each (~50s, the stage
  // move + quote-link stamp) PLUS the event-date push's own internally
  // deadline-bounded ≤6s (FIX E, #237 fix round — this comment predated the
  // event-date push and was never updated when that 6th step landed inside
  // the same chain; the push's ≤6s is a SEPARATE Promise.race inside
  // pushEventDateToGhl, not part of this 10s-per-call GHL_TIMEOUT_MS chain —
  // see PUSH_DEADLINE_MS in ghlEventDate.ts) — ~56s worst case, not ~50s.
  // Still comfortably inside Vercel's Fluid Compute default function timeout
  // of 300s (verified via Vercel docs + this project's plan) — no
  // maxDuration export needed (round-2 staff-lens correction to round 1's
  // fix 5, which had assumed a 60s default).
  await Promise.allSettled([ghlStageChain(), customerSms(), customerEmail(), tagPropagationRaced()]);

  // Release only the exact claims this request won. If the invocation crashed,
  // the two-minute leases expire on their own; if a later request has already
  // reclaimed a stale lease, an older request cannot clear that newer claim.
  await Promise.all(effectClaims.map(async ({ column, claimedAt }) => {
    try {
      const { error: releaseErr } = await withDbTimeout((signal) =>
        sb
          .from('quotes')
          .update({ [column]: null })
          .eq('id', id)
          .eq(column, claimedAt)
          .abortSignal(signal),
      );
      if (releaseErr) {
        console.warn('[api/quotes/:id/send] retry claim release failed:', releaseErr.message);
      }
    } catch (error) {
      console.warn('[api/quotes/:id/send] retry claim release failed:', error);
    }
  }));

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
        // Row 271: mirror the 200 body's stage-outcome fields (below) — the
        // 502 branch sits AFTER the same Promise.allSettled that runs
        // ghlStageChain, so stageUpdated/stageError/opportunityId/ghlSynced
        // are already settled by the time we get here. Omitting them made a
        // split failure (message delivery dies, GHL card move succeeds) look
        // like nothing happened at all: PipelineActionsMenu.tsx's stage line
        // already reads stageUpdated/stageError whenever they're present, so
        // this closes the gap route-side with no menu change needed. On a
        // delivery-only retry (isDeliveryRetry) ghlStageChain returns
        // immediately without touching stageUpdated/stageError/opportunityId
        // — they stay at their untouched values (stageUpdated false,
        // stageError undefined, opportunityId whatever was already on the
        // row), which correctly says "this attempt never touched the stage"
        // rather than asserting a false move or a false error. ghlSynced
        // still reflects reality on a retry via the same expression the 200
        // body uses: false unless a PRIOR send already synced the card
        // (quote.ghl_stage_synced_at).
        stageUpdated,
        stageError,
        opportunityId,
        ghlSynced: stageUpdated || (isDeliveryRetry && quote.ghl_stage_synced_at != null),
        // FIX A (#237 fix round): same reasoning as the 200 body below —
        // mirror it here too so a split failure (delivery fails AND the
        // event-date push failed) doesn't drop this half of the picture.
        eventDateSyncError,
        // Row 340 fix round: mirror the 200 body's field below — a split
        // failure (delivery fails AND the browsing-selection clear was
        // dropped by the TOCTOU guard) must not lose this half either.
        ...(browsingSelectionClearSkipped ? { browsingSelectionClearSkipped: true } : {}),
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
    // FIX A (#237 fix round, staff-lens HIGH): undefined = nothing to report
    // (not an event quote / no contact / test quote / nothing to push, or the
    // push succeeded); a string = the push was attempted and
    // pushEventDateToGhl reported pushed:false. See QuoteBuilder.tsx's
    // eventDateSyncWarning banner.
    eventDateSyncError,
    smsSent,
    emailSent,
    messageError,
    failedChannels,
    // Task 10 — channel split: echo the resolved channel for observability.
    channel,
    // #116: flags a revive run (declined/abandoned → sent on the SAME quote) so
    // the operator UI can distinguish it from a fresh/first send.
    ...(isRevive ? { revived: true } : {}),
    // Row 340 fix round: present only when the operator asked to clear the
    // stale browsing selection and the TOCTOU guard dropped it (the row's
    // browsing_selection_updated_at no longer matched what they were shown)
    // — the send itself still succeeded; only the clear was skipped.
    ...(browsingSelectionClearSkipped ? { browsingSelectionClearSkipped: true } : {}),
  });
}
