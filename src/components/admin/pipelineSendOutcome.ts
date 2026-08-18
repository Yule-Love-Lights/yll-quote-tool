// src/components/admin/pipelineSendOutcome.ts
//
// Row 270: pure response -> decision logic for PipelineActionsMenu's 'send'
// case, split out so the honesty rules (what to tell the operator, whether
// and which channel to offer a `?retryDelivery=1` redeliver for) are
// unit-testable without a DOM. No IO here — see PipelineActionsMenu.tsx for
// the fetch/alert/confirm flow that calls this.
//
// The send route (src/app/api/quotes/[id]/send/route.ts) returns the SAME
// response shape for a fresh send and a `?retryDelivery=1` retry — they
// share one response-construction path (lines ~849-889), plus the identical
// alreadySent short-circuit at the top of the route (~line 345) — so one
// function classifies both; `isRetry` changes only the WORDING for a couple
// of branches below, never which branch is taken.

export type Channel = 'sms' | 'email' | 'both';

// Row 269 fix round FIX 1 (three-lens HIGH — sibling-guard parity with
// QuoteBuilder.tsx, which already reads the route's channelOutcomes field):
// one channel's classified delivery outcome from the send route's
// alreadySent short-circuit (route.ts's channelOutcomes field — see that
// route's response-shape doc comment). Structurally matches
// QuoteDeliveryChannelOutcome (src/lib/quoteDeliveries.ts) but is NOT
// imported from there — same client/server-boundary reasoning as
// TIMEOUT_HEDGE_PREFIX below: this file has ZERO imports on purpose, and
// PipelineActionsMenu.tsx ('use client') imports it, so pulling in
// quoteDeliveries.ts would drag its server-only Supabase service client into
// the browser bundle (the #52/S18 class of bug).
export type ChannelOutcomeEntry = { outcome: 'sent' | 'failed'; error: string | null; at: string };

// The subset of the route's JSON body this menu reads. Some fields only
// exist on some response shapes — `messageError` is 200-only (the 502
// delivery-failed body folds the identical text into `error` instead, since
// that response has no separate messageError field — see route.ts's two
// return statements) — so everything here is optional. `channelOutcomes` is
// set ONLY on the alreadySent short-circuit, and only when the route's own
// best-effort read succeeded (see route.ts's own doc comment on the field).
export type SendResponseBody = {
  alreadySent?: boolean;
  code?: string;
  error?: string;
  messageError?: string;
  failedChannels?: unknown;
  channelOutcomes?: { sms: ChannelOutcomeEntry | null; email: ChannelOutcomeEntry | null };
};

// Row 270 fix round, FIX 3 (customer MED): which UI gate the caller must use
// before firing retryPrompt's redeliver. 'confirm' is a plain
// window.confirm — correct whenever the customer did NOT receive anything on
// THIS attempt (a partial 200 failure or a 502 delivery-failed) AND that
// non-delivery is a CONFIRMED rejection, since a duplicate send is
// structurally impossible on a channel that genuinely just failed.
//
// Row 290 fix (customer MED): that "impossible" claim is FALSE for a GHL
// OUTCOME-UNKNOWN failure. The send route's deliveryErrorMessage()/
// timeoutHedgedErrorMessage() (src/app/api/quotes/[id]/send/route.ts) mark an
// SMS/email whose true delivery result we never learned as outcome UNKNOWN,
// not confirmed-failed — GHL may have already delivered it before we lost the
// ability to confirm that (the "timeout — " DELIVERY_TIMEOUT_ERROR_PREFIX
// lead, src/lib/quoteDeliveries.ts). Redelivering that channel on a plain
// confirm risks a REAL duplicate SMS/email. So 'typed-yes' actually covers
// TWO cases sharing the same risk (the customer may already have the quote)
// and the same mitigation: the fresh-send alreadySent path below, and any
// partial/502 failure whose error detail carries the outcome-unknown-hedge
// prefix (see isTimeoutHedgedFailure + retryOfferFor below) — the real
// invariant is "impossible EXCEPT an outcome-unknown-hedged failure", not
// unconditionally impossible.
//
// Row 269 fix round 2 (delta-verify HIGH): "outcome-unknown-hedged" is wider
// than a literal request timeout as of this round — the send route now
// applies the SAME prefix whenever it never received a definitive HTTP
// response from GHL (a socket reset, DNS failure, connection refused, or our
// own timeout all qualify; see timeoutHedgedErrorMessage's comment in the
// send route for the full reasoning). This file's own logic (a substring
// check on the prefix) is unchanged — only what upstream writes that prefix
// FOR has widened, so any comment here saying "timeout" specifically means
// "whatever the send route currently hedges," not literally request-timeout-
// only.
//
// The caller's alert() immediately precedes the retry offer, and
// alert()/confirm() both dismiss/accept under the Enter key, so a reflexive
// Enter-Enter could fire a REAL duplicate SMS/email. 'typed-yes' routes the
// caller to a window.prompt requiring an exact, case-insensitive "YES"
// instead — a reflexive Enter alone submits '' and aborts. This keeps the
// gating decision in this pure, unit-tested helper rather than
// duplicated/guessed at in the DOM caller.
export type RetryGate = 'confirm' | 'typed-yes';

export type SendOutcome = {
  // Extra honesty line for the alert, beyond the caller's existing
  // portal-URL/stage lines — '' when the response needs no correction (full
  // success, or the alreadySent-on-a-fresh-send case, whose "(already sent
  // earlier)" is already stated by the caller's own existing suffix).
  message: string;
  // Channel to offer a `?retryDelivery=1` redeliver for, or null when
  // nothing failed OR a retry can't work (a RETRY's own alreadySent — the
  // quote's status moved on since the original send).
  retryChannel: Channel | null;
  // Prompt text for the retry offer (the exact dialog kind depends on
  // retryGate, below). Set exactly when retryChannel is non-null (kept as a
  // separate field, not derived at the call site, so the wording can name
  // the actual scenario — e.g. "no new message was sent" is only true for
  // the alreadySent case).
  retryPrompt: string | null;
  // Non-null exactly when retryChannel/retryPrompt are non-null (all three
  // are set together in every branch below) — see RetryGate's doc comment.
  retryGate: RetryGate | null;
};

function toChannelArray(value: unknown): ('sms' | 'email')[] {
  if (!Array.isArray(value)) return [];
  // Row 270 fix round, FIX 5a (technical LOW): dedupe defensively.
  // toRetryChannel (below) treats "2 entries" as proof BOTH channels are
  // present and maps that straight to 'both' — a hypothetical malformed
  // ['sms','sms'] would otherwise be mis-read as "both channels failed"
  // instead of "sms failed twice-reported."
  return Array.from(new Set(value.filter((v): v is 'sms' | 'email' => v === 'sms' || v === 'email')));
}

// The only way BOTH sms+email land in failedChannels is a channel:'both'
// request where neither delivered, so 2 failed always maps to 'both'.
// Callers only invoke this with a non-empty array.
function toRetryChannel(failed: ('sms' | 'email')[]): Channel {
  return failed.length === 2 ? 'both' : failed[0];
}

function channelLabel(channel: Channel): string {
  return channel === 'both' ? 'email + text' : channel === 'sms' ? 'text' : 'email';
}

// Row 290: the exact prefix deliveryErrorMessage()/timeoutHedgedErrorMessage()
// (src/app/api/quotes/[id]/send/route.ts) write onto smsError/emailError
// whenever we never got a definitive HTTP response back from HighLevel,
// rather than a confirmed rejection — GHL may have already delivered it
// before we lost the ability to confirm that. Row 269 fix round 2
// (delta-verify HIGH): this is NOT limited to a literal request timeout — a
// socket reset, DNS failure, connection refused, or any other non-status-
// bearing failure gets the identical prefix now (see timeoutHedgedErrorMessage
// 's comment in the send route for why "our own timeout" was too narrow a
// discriminator). This is a duplicated literal, not an import of
// quoteDeliveries.ts's exported DELIVERY_TIMEOUT_ERROR_PREFIX: that module
// pulls in the server-only Supabase service client (getSupabaseServiceClient),
// and this file is imported by PipelineActionsMenu.tsx ('use client') —
// importing it here would drag that server-only chain into the browser
// bundle (the #52/S18 class of bug). pipelineSendOutcome.test.ts builds its
// timeout fixtures from the REAL exported constant, so any drift between the
// two copies fails a test instead of going unnoticed.
const TIMEOUT_HEDGE_PREFIX = 'timeout — ';

// `.includes`, not `.startsWith`: body.error/body.messageError can be TWO
// channels' error text joined with '; ' (messageError =
// [smsError, emailError].filter(Boolean).join('; ') in the route, folded
// into body.error for the 502 shape — see SendResponseBody's doc comment
// above) — the prefix lands mid-string whenever only the SECOND channel
// timed out.
//
// PR #786 review (technical LOW, accepted trade): this is a plain substring
// match over text that can carry up to 400 chars of GHL's own raw response
// body verbatim (HighLevelError's message, built in ghlFetch's !res.ok
// branch — src/lib/integrations/highlevel.ts ~148-153 — is
// `... : ${body.slice(0, 400)}`). If a CONFIRMED (non-timeout) HighLevel
// error body ever happened to literally contain the text "timeout — ", this
// would misdetect it as timeout-hedged and over-gate a real, non-ambiguous
// failure to typed-YES instead of confirm. Accepted because the failure
// direction is SAFE (typed-YES is stricter than confirm, never looser — the
// worst case is one extra keystroke, never a missed hedge) and the em-dash
// makes an accidental collision unlikely. The real fix, if this ever bites,
// is a structured boolean (e.g. route.ts setting a `timedOut` flag per
// channel on the response body) instead of string-sniffing — not attempted
// here since it's a route.ts response-shape change, out of scope for this
// pure-function fix.
// Row 269: exported so QuoteBuilder.tsx (src/components/quote/) can classify
// its OWN raw error/warning text (sendError, deliveryWarning's
// data.messageError source) the exact same way this file already does,
// instead of duplicating the substring check or a second copy of
// TIMEOUT_HEDGE_PREFIX. Was private until QuoteBuilder needed it — no
// behavior change.
export function isTimeoutHedgedFailure(detail: string | undefined): boolean {
  return !!detail && detail.includes(TIMEOUT_HEDGE_PREFIX);
}

// Row 269: the per-channel counterpart to isTimeoutHedgedFailure above —
// classifies ONE channel's row from the send route's new channelOutcomes
// field (POST /api/quotes/[id]/send's alreadySent short-circuit; see that
// route's response-shape doc comment) into what QuoteBuilder.tsx's
// already-sent notice should say and whether that channel belongs in a
// scoped redeliver offer.
//
// 'sent' -> 'delivered': a confirmed success, never offered for redeliver.
// 'failed' with an outcome-unknown-hedged error -> 'unknown': same reasoning
// as isTimeoutHedgedFailure above — GHL may have delivered it anyway even
// though we never got a definitive answer back (row 269 fix round 2: not
// only a literal timeout — see that function's doc comment), so this is NOT
// a confirmed non-delivery.
// 'failed' otherwise -> 'failed': a confirmed rejection.
// null/undefined (no delivery row was ever logged for this channel, or the
// read itself failed and channelOutcomes is missing entirely) -> 'unknown':
// there is no basis to claim either a confirmed delivery or a confirmed
// failure, so the caller must treat it the same as a genuine failure for
// retry-scoping purposes (offer it) while wording the notice honestly.
export type ChannelDeliveryClassification = 'delivered' | 'failed' | 'unknown';

export function classifyChannelOutcome(
  entry: { outcome: 'sent' | 'failed'; error: string | null } | null | undefined,
): ChannelDeliveryClassification {
  if (!entry) return 'unknown';
  if (entry.outcome === 'sent') return 'delivered';
  return isTimeoutHedgedFailure(entry.error ?? undefined) ? 'unknown' : 'failed';
}

// Row 290 fix (customer MED): the one place a partial/502 delivery failure
// picks its RetryGate — see RetryGate's doc comment for the invariant this
// implements. A confirmed failure (the normal case) stays low-friction
// 'confirm'. A timeout-hedged failure routes to the SAME 'typed-yes' gate as
// the alreadySent path below (same underlying risk: the customer may
// already have the quote from GHL's side even though our request errored),
// with its OWN prompt wording — see the timeoutHedged branch below for why
// it can't reuse alreadySent's exact copy. `channel` here may be 'both'
// (toRetryChannel maps 2 failedChannels to 'both') — retrying 'both' would
// re-touch a channel whose failure was CONFIRMED alongside one that wasn't,
// so `timeoutHedged` being true for either component gates the WHOLE offer
// (see isTimeoutHedgedFailure's `.includes` note above).
//
// `isRetry`/`timeoutHedged` are two adjacent booleans with no compiler check
// stopping a transposed call (PR #786 review, technical LOW) — both call
// sites below pass `isRetry` verbatim and a same-line
// `isTimeoutHedgedFailure(...)` call, never a bare second boolean variable,
// so there's nothing to transpose today; flagged here for whoever adds a
// third call site later.
// Row 269: exported so QuoteBuilder.tsx's three retry buttons (which have no
// confirm gate of any kind today, and don't route through decideSendOutcome
// — they manage their own state independently of PipelineActionsMenu's
// 'send' case) can pick the SAME gate/prompt for a given channel + hedge
// state instead of a second, possibly-drifting implementation. Was private
// until QuoteBuilder needed it — no behavior change for PipelineActionsMenu.
export function retryOfferFor(
  channel: Channel,
  isRetry: boolean,
  timeoutHedged: boolean,
): { retryPrompt: string; retryGate: RetryGate } {
  if (timeoutHedged) {
    // PR #786 review (staff MED + customer LOW, converged): the prior
    // wording ("GHL may have gone through anyway, so the customer may
    // already have it") was accurate for a PURE timeout but overclaimed for
    // a MIXED 'both' failure (one channel timeout-hedged, one confirmed
    // rejection) — "the customer may already have it" reads as covering
    // BOTH channels, when only the timeout-hedged one might have arrived.
    // Taking it at face value, an operator could cancel the WHOLE retry on
    // a channel that verifiably delivered nothing. This function only has a
    // single `timeoutHedged` boolean (no per-channel detail — see the
    // doc comment above for why that's the real granularity), so the copy
    // is worded to stay true for BOTH the pure and mixed shapes without
    // naming which specific channel is which.
    //
    // Row 269 fix round 2 (delta-verify HIGH, found while widening the
    // upstream invariant): was "This attempt included a timeout —", which
    // asserted the SPECIFIC cause was a timeout. It no longer always is — the
    // send route now hedges the identical way for a socket reset, DNS
    // failure, or connection refused (any non-definitive GHL response; see
    // timeoutHedgedErrorMessage's comment in the send route), and this
    // boolean can't distinguish those from a literal timeout. Reworded to the
    // true, cause-agnostic claim: the outcome is unknown, not specifically
    // that it timed out.
    return {
      retryPrompt: `This attempt's outcome is unknown — the customer MAY already have that message. Any channel that failed outright did NOT arrive. Type YES to redeliver ${channelLabel(channel)} ${isRetry ? 'again' : 'now'}:`,
      retryGate: 'typed-yes',
    };
  }
  return {
    retryPrompt: `Redeliver ${channelLabel(channel)} ${isRetry ? 'again' : 'now'}?`,
    retryGate: 'confirm',
  };
}

/**
 * Classifies one send-route response into what to tell the operator and
 * whether to offer a redeliver retry.
 *
 * `requestedChannel` is the channel THIS call asked for (action.channel on a
 * fresh send, or the channel just retried) — used as the retry-offer
 * fallback only when the response carries no failedChannels of its own (the
 * alreadySent short-circuit never attempts delivery, so it never populates
 * failedChannels).
 *
 * `isRetry` changes only the WORDING, never which branch fires: a fresh
 * send's alreadySent means "this click delivered nothing, want to
 * redeliver?" (redelivery is still live — offered via the returned
 * retryChannel); a RETRY's alreadySent means the quote's status moved on
 * BETWEEN the original send and this retry (approved, booked, …) —
 * redelivery is no longer possible (mirrors QuoteBuilder.tsx's
 * handleRetryDelivery "#241 defect 2" handling of the identical shape, ~line
 * 6007: don't repeat the same doomed retry, say so plainly instead).
 */
export function decideSendOutcome(
  ok: boolean,
  body: SendResponseBody,
  requestedChannel: Channel,
  isRetry: boolean,
): SendOutcome {
  if (body.alreadySent) {
    if (isRetry) {
      return {
        message:
          'Redeliver didn’t send anything either — this quote has moved past "sent"/"viewed" since the original send, so an automatic resend is blocked.',
        retryChannel: null,
        retryPrompt: null,
        retryGate: null,
      };
    }
    // Row 269 fix round FIX 1 (three-lens HIGH — sibling-guard parity):
    // this branch used to offer `requestedChannel` unconditionally, with no
    // regard for whether the ORIGINAL send already confirm-delivered it —
    // QuoteBuilder.tsx's identical alreadySent handling already scopes its
    // offer to classifyChannelOutcome(body.channelOutcomes); this is the
    // same scoping for PipelineActionsMenu. `covered` is which channel(s)
    // requestedChannel actually asks about; `offered` drops any already
    // 'delivered' — an operator clicking "Send (email + text)" on a quote
    // whose SMS already confirmed no longer gets an unscoped 'both' offer
    // that would re-fire a channel GHL already accepted (no idempotency key
    // on GHL's send endpoint — that's a REAL duplicate, not a wasted click).
    const covered: ('sms' | 'email')[] = requestedChannel === 'both' ? ['sms', 'email'] : [requestedChannel];
    const classified = covered.map((ch) => ({
      channel: ch,
      classification: classifyChannelOutcome(body.channelOutcomes?.[ch]),
    }));
    const delivered = classified.filter((c) => c.classification === 'delivered').map((c) => c.channel);
    const offered = classified.filter((c) => c.classification !== 'delivered');

    // CRITICAL COMPATIBILITY case: body.channelOutcomes absent (older
    // response, or the route's own best-effort read failed) —
    // classifyChannelOutcome(undefined) returns 'unknown' for every covered
    // channel, so `offered` reduces to exactly `covered` (nothing gets
    // filtered as 'delivered') and `offerChannel` below reduces to exactly
    // `requestedChannel` — today's behavior, byte-identical prompts.
    if (offered.length === 0) {
      // Every channel this click asked for already confirmed-delivered on
      // the earlier send — offering a redeliver here would be a GUARANTEED
      // real duplicate, not just a risk, so there is nothing to offer.
      return {
        message: `${channelLabel(requestedChannel)} already delivered for this quote — nothing to redeliver. Share the portal URL with the customer directly if they need it again.`,
        retryChannel: null,
        retryPrompt: null,
        retryGate: null,
      };
    }

    const offerChannel: Channel = offered.length === 2 ? 'both' : offered[0].channel;
    // FIX 3's rule, applied here too so the two surfaces don't drift (brief
    // requirement): an offered channel classified 'unknown' means a
    // duplicate is still POSSIBLE (no delivery row logged, or a
    // timeout-hedged failure on the earlier send — same ambiguity as
    // RetryGate's doc comment above) -> typed-yes. An offered channel
    // classified 'failed' is a CONFIRMED rejection on the earlier send -> a
    // duplicate on THAT channel is impossible. The strictest classification
    // among the offered channels wins for a 'both' offer (mirrors
    // retryOfferFor's `timeoutHedged` gates-the-whole-offer reasoning).
    const gate: RetryGate = offered.some((c) => c.classification === 'unknown') ? 'typed-yes' : 'confirm';
    const alreadyNote = delivered.length > 0 ? `${channelLabel(delivered[0])} already delivered. ` : '';
    const retryPrompt =
      gate === 'typed-yes'
        ? // Row 270 fix round, FIX 3 + FIX 4: was `No new message was sent —
          // deliver ${channelLabel} again now?`, paired with a plain
          // window.confirm — see RetryGate's doc comment for why that
          // chained an alert()-then-confirm() reflex-Enter risk for a
          // customer who may already have the quote. Reworded
          // channel-history-neutral too (dropped "again"): quote_sent_at is
          // channel-agnostic, so the clicked channel may never have been
          // attempted even once (e.g. the original send was email-only and
          // the operator just clicked "Send text").
          `${alreadyNote}This quote was already sent earlier and the customer may already have it. Type YES to send ${channelLabel(offerChannel)} for this quote now:`
        : `${alreadyNote}This quote was already sent earlier, but ${channelLabel(offerChannel)} confirmed failed to deliver — send it now?`;
    return {
      message: '',
      retryChannel: offerChannel,
      retryPrompt,
      retryGate: gate,
    };
  }

  const failedChannels = toChannelArray(body.failedChannels);

  if (!ok) {
    if (body.code === 'delivery-failed') {
      const detail = body.error ? ` (${body.error})` : '';
      const channel = failedChannels.length > 0 ? toRetryChannel(failedChannels) : requestedChannel;
      // Row 290: body.error is where the 502 body folds messageError's text
      // (see SendResponseBody's doc comment above) — check IT for the
      // timeout-hedge prefix; a 502-shaped body never sets messageError.
      const { retryPrompt, retryGate } = retryOfferFor(channel, isRetry, isTimeoutHedgedFailure(body.error));
      return {
        message: isRetry
          ? `Still not delivered.${detail}`
          : `Quote marked sent, but no message was delivered.${detail}`,
        retryChannel: channel,
        retryPrompt,
        retryGate,
      };
    }
    // Any other failure (empty-quote, no-contact, view-only, deposit-paid,
    // send-conflict, a malformed/empty body, …) — none of these change
    // server state and none are delivery-retryable; the caller just alerts
    // this message, matching onPick's old generic `!res.ok` handling.
    return { message: body.error ?? 'Action failed', retryChannel: null, retryPrompt: null, retryGate: null };
  }

  if (failedChannels.length === 0) {
    return { message: isRetry ? 'Delivered.' : '', retryChannel: null, retryPrompt: null, retryGate: null };
  }

  // Partial failure: the route only reaches a 200 with a non-empty
  // failedChannels when SOME but not ALL requested channels failed (ALL
  // failed is the 502 delivery-failed branch above), which is only
  // reachable from a channel:'both' request — so "the other requested
  // channel was delivered" is always true here (mirrors QuoteBuilder.tsx's
  // identical copy for this exact response shape, ~line 3078). Exactly ONE
  // channel is ever in failedChannels here (the other one succeeded), so
  // body.messageError below is always a single channel's error text, never
  // a joined pair (that only happens in the 502 branch above).
  const channel = toRetryChannel(failedChannels);
  const { retryPrompt, retryGate } = retryOfferFor(channel, isRetry, isTimeoutHedgedFailure(body.messageError));
  return {
    message: `${failedChannels.map((c) => c.toUpperCase()).join(' and ')} failed. The other requested channel was delivered.${body.messageError ? ` (${body.messageError})` : ''}`,
    retryChannel: channel,
    retryPrompt,
    retryGate,
  };
}
