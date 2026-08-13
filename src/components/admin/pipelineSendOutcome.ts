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

// The subset of the route's JSON body this menu reads. Some fields only
// exist on some response shapes — `messageError` is 200-only (the 502
// delivery-failed body folds the identical text into `error` instead, since
// that response has no separate messageError field — see route.ts's two
// return statements) — so everything here is optional.
export type SendResponseBody = {
  alreadySent?: boolean;
  code?: string;
  error?: string;
  messageError?: string;
  failedChannels?: unknown;
};

// Row 270 fix round, FIX 3 (customer MED): which UI gate the caller must use
// before firing retryPrompt's redeliver. 'confirm' is a plain
// window.confirm — correct whenever the customer did NOT receive anything
// on THIS attempt (a partial 200 failure or a 502 delivery-failed), since a
// duplicate send is structurally impossible on a channel that just failed.
// 'typed-yes' is reserved for the ONE case where the customer may already
// have the quote (a fresh send's alreadySent, below) — the caller's alert()
// immediately precedes the retry offer, and alert()/confirm() both dismiss/
// accept under the Enter key, so a reflexive Enter-Enter could fire a REAL
// duplicate SMS/email. 'typed-yes' routes the caller to a window.prompt
// requiring an exact, case-insensitive "YES" instead — a reflexive Enter
// alone submits '' and aborts. This keeps the gating decision in this pure,
// unit-tested helper rather than duplicated/guessed at in the DOM caller.
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
    return {
      message: '',
      retryChannel: requestedChannel,
      // Row 270 fix round, FIX 3 + FIX 4: was `No new message was sent —
      // deliver ${channelLabel} again now?`, paired with a plain
      // window.confirm — see RetryGate's doc comment for why that chained
      // an alert()-then-confirm() reflex-Enter risk for a customer who may
      // already have the quote. Reworded channel-history-neutral too
      // (dropped "again"): quote_sent_at is channel-agnostic, so the
      // clicked channel may never have been attempted even once (e.g. the
      // original send was email-only and the operator just clicked "Send
      // text").
      retryPrompt: `This quote was already sent earlier and the customer may already have it. Type YES to send ${channelLabel(requestedChannel)} for this quote now:`,
      retryGate: 'typed-yes',
    };
  }

  const failedChannels = toChannelArray(body.failedChannels);

  if (!ok) {
    if (body.code === 'delivery-failed') {
      const detail = body.error ? ` (${body.error})` : '';
      const channel = failedChannels.length > 0 ? toRetryChannel(failedChannels) : requestedChannel;
      return {
        message: isRetry
          ? `Still not delivered.${detail}`
          : `Quote marked sent, but no message was delivered.${detail}`,
        retryChannel: channel,
        retryPrompt: `Redeliver ${channelLabel(channel)} ${isRetry ? 'again' : 'now'}?`,
        // The customer got NOTHING on this attempt — a duplicate send on
        // this channel is structurally impossible, so low-friction confirm
        // stays correct (see RetryGate's doc comment).
        retryGate: 'confirm',
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
  // identical copy for this exact response shape, ~line 3078).
  const channel = toRetryChannel(failedChannels);
  return {
    message: `${failedChannels.map((c) => c.toUpperCase()).join(' and ')} failed. The other requested channel was delivered.${body.messageError ? ` (${body.messageError})` : ''}`,
    retryChannel: channel,
    retryPrompt: `Redeliver ${channelLabel(channel)} ${isRetry ? 'again' : 'now'}?`,
    // The other requested channel WAS delivered, but this one wasn't — the
    // customer has nothing from this specific channel, so confirm stays
    // correct (see RetryGate's doc comment).
    retryGate: 'confirm',
  };
}
