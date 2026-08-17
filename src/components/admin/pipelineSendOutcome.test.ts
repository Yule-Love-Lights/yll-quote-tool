// src/components/admin/pipelineSendOutcome.test.ts
// Row 270: decideSendOutcome is the pure response -> decision core behind
// PipelineActionsMenu's 'send' case — see that file's helper doc comment for
// why one function classifies both a fresh send and a ?retryDelivery=1 retry.
import { describe, it, expect } from 'vitest';
import { decideSendOutcome } from './pipelineSendOutcome';
// Row 290: the REAL exported constant the send route writes onto a timed-out
// smsError/emailError (src/lib/quoteDeliveries.ts, via
// deliveryErrorMessage()/timeoutHedgedErrorMessage() in
// src/app/api/quotes/[id]/send/route.ts) — fixtures below build their
// body.error/messageError from THIS, not a hand-typed 'timeout — ' guess, so
// a drifted/renamed prefix fails these tests instead of the two copies
// silently disagreeing (see pipelineSendOutcome.ts's own duplicated-literal
// comment for why it isn't imported there — client/server bundle boundary).
import { DELIVERY_TIMEOUT_ERROR_PREFIX } from '@/lib/quoteDeliveries';

describe('decideSendOutcome', () => {
  it('full success (both channels delivered) — no extra message, no retry offered', () => {
    expect(decideSendOutcome(true, { failedChannels: [] }, 'both', false)).toEqual({
      message: '',
      retryChannel: null,
      retryPrompt: null,
      retryGate: null,
    });
  });

  it('failedChannels missing entirely (not an array) is treated as no failures', () => {
    expect(decideSendOutcome(true, {}, 'both', false)).toEqual({
      message: '',
      retryChannel: null,
      retryPrompt: null,
      retryGate: null,
    });
  });

  // #93 Test Quote: send/route.ts forces requestedChannels = [] whenever
  // quote.is_test (never attempts real delivery), so failedChannels is
  // ALWAYS [] on a test quote's response — the exact same shape as a
  // genuine full success. Asserted explicitly so a future change can't
  // silently start treating a test quote's send as a failure.
  it('is_test-shaped response (failedChannels forced empty server-side) behaves exactly like full success', () => {
    const outcome = decideSendOutcome(true, { failedChannels: [] }, 'both', false);
    expect(outcome.message).toBe('');
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryGate).toBeNull();
  });

  it('200 partial failure (one of two requested channels failed) — honest message + offers a CONFIRM-gated retry for the failed channel (#270 fix round FIX 3: the customer DID get the other channel, but got nothing from this one, so low friction is correct)', () => {
    const outcome = decideSendOutcome(
      true,
      { failedChannels: ['sms'], messageError: 'rate limited' },
      'both',
      false,
    );
    expect(outcome.message).toBe('SMS failed. The other requested channel was delivered. (rate limited)');
    expect(outcome.retryChannel).toBe('sms');
    expect(outcome.retryPrompt).toBe('Redeliver text now?');
    expect(outcome.retryGate).toBe('confirm');
  });

  it('200 partial failure with no messageError omits the parenthetical (still a confirm gate)', () => {
    const outcome = decideSendOutcome(true, { failedChannels: ['email'] }, 'both', false);
    expect(outcome.message).toBe('EMAIL failed. The other requested channel was delivered.');
    expect(outcome.retryPrompt).toBe('Redeliver email now?');
    expect(outcome.retryGate).toBe('confirm');
  });

  it('502 all-requested-channels-failed (delivery-failed) — says the quote was marked sent locally, offers a CONFIRM-gated retry (#270 fix round FIX 3: nothing was delivered on this attempt, so low friction is correct)', () => {
    const outcome = decideSendOutcome(
      false,
      { code: 'delivery-failed', error: 'HighLevel unreachable', failedChannels: ['sms', 'email'] },
      'both',
      false,
    );
    expect(outcome.message).toBe('Quote marked sent, but no message was delivered. (HighLevel unreachable)');
    expect(outcome.retryChannel).toBe('both');
    expect(outcome.retryPrompt).toBe('Redeliver email + text now?');
    expect(outcome.retryGate).toBe('confirm');
  });

  it('502 for a single-channel request offers retry for that one channel', () => {
    const outcome = decideSendOutcome(
      false,
      { code: 'delivery-failed', error: 'timeout', failedChannels: ['sms'] },
      'sms',
      false,
    );
    expect(outcome.retryChannel).toBe('sms');
    expect(outcome.retryPrompt).toBe('Redeliver text now?');
    expect(outcome.retryGate).toBe('confirm');
  });

  it('502 with failedChannels missing falls back to the requested channel', () => {
    const outcome = decideSendOutcome(false, { code: 'delivery-failed', error: 'boom' }, 'email', false);
    expect(outcome.retryChannel).toBe('email');
    expect(outcome.retryGate).toBe('confirm');
  });

  // Row 290 (S39 wrap customer-lens MED): the 'confirm' comments this fix
  // replaced both said a duplicate is "structurally impossible" on a channel
  // that just failed — false for a GHL TIMEOUT failure, whose true outcome
  // is UNKNOWN (GHL may have delivered it before our socket gave up
  // waiting — see RetryGate's doc comment in pipelineSendOutcome.ts). A
  // confirm-gated redeliver on that channel risks a REAL duplicate
  // SMS/email, so it now gets the alreadySent-idiom typed-yes gate instead.
  describe('Row 290: timeout-hedged failures get typed-yes, not confirm', () => {
    it('502 delivery-failed with a TIMEOUT-hedged error — typed-YES gate (alreadySent idiom)', () => {
      const outcome = decideSendOutcome(
        false,
        {
          code: 'delivery-failed',
          error: `${DELIVERY_TIMEOUT_ERROR_PREFIX}delivery outcome unknown (GHL may have still delivered it): HighLevel POST /conversations/messages timed out after 10000ms`,
          failedChannels: ['sms'],
        },
        'sms',
        false,
      );
      expect(outcome.retryChannel).toBe('sms');
      expect(outcome.retryGate).toBe('typed-yes');
      expect(outcome.retryPrompt).toBe(
        'This attempt included a timeout — the customer MAY already have that message. Any channel that failed outright did NOT arrive. Type YES to redeliver text now:',
      );
    });

    it('502 delivery-failed with a PLAIN (non-timeout) error — confirm gate unchanged', () => {
      const outcome = decideSendOutcome(
        false,
        { code: 'delivery-failed', error: 'HighLevel rejected the request (400)', failedChannels: ['sms', 'email'] },
        'both',
        false,
      );
      expect(outcome.retryChannel).toBe('both');
      expect(outcome.retryGate).toBe('confirm');
      expect(outcome.retryPrompt).toBe('Redeliver email + text now?');
    });

    it('200 partial failure with a TIMEOUT-hedged messageError — typed-YES gate', () => {
      const outcome = decideSendOutcome(
        true,
        {
          failedChannels: ['email'],
          messageError: `${DELIVERY_TIMEOUT_ERROR_PREFIX}delivery outcome unknown (GHL may have still delivered it): HighLevel POST /emails timed out after 10000ms`,
        },
        'both',
        false,
      );
      expect(outcome.retryChannel).toBe('email');
      expect(outcome.retryGate).toBe('typed-yes');
      expect(outcome.retryPrompt).toBe(
        'This attempt included a timeout — the customer MAY already have that message. Any channel that failed outright did NOT arrive. Type YES to redeliver email now:',
      );
    });

    it('200 partial failure with a PLAIN messageError — confirm gate unchanged (pre-existing behavior, pinned post-fix)', () => {
      const outcome = decideSendOutcome(
        true,
        { failedChannels: ['sms'], messageError: 'rate limited' },
        'both',
        false,
      );
      expect(outcome.retryGate).toBe('confirm');
    });

    // Proves the seam route.ts -> pipelineSendOutcome.ts (row 290's "prove
    // the prefix actually flows" ask — untested before this fix:
    // route.test.ts's timeout coverage only asserts the DB-logged
    // quote_deliveries row, never the HTTP response body's error/
    // messageError). This is exactly the shape route.ts's messageError
    // construction produces (`[smsError, emailError].filter(Boolean).join('
    // ; ')`, folded into body.error for the 502 shape) when ONE requested
    // channel times out and the OTHER gets a confirmed rejection.
    //
    // PR #786 review (staff MED + customer LOW, converged): also pins the
    // PROMPT text is honest for this exact mixed shape, not just the gate —
    // the prior wording's "the customer may already have it" read as
    // covering BOTH channels, when here only the email leg is ambiguous and
    // the sms leg verifiably delivered nothing. The new copy makes no
    // per-channel claim (retryOfferFor only has ONE timeoutHedged boolean —
    // see its doc comment) but is still true for both halves at once.
    it('502 with BOTH channels failed, only ONE via timeout (mixed) — the joined error still trips typed-yes for the WHOLE "both" offer, with honest (non-overclaiming) prompt copy', () => {
      const mixedError = `SMS provider rejected the number (400); ${DELIVERY_TIMEOUT_ERROR_PREFIX}delivery outcome unknown (GHL may have still delivered it): email socket reset`;
      const outcome = decideSendOutcome(
        false,
        { code: 'delivery-failed', error: mixedError, failedChannels: ['sms', 'email'] },
        'both',
        false,
      );
      // decideSendOutcome's real granularity: ONE retryChannel/retryGate for
      // the WHOLE response (SendOutcome has no per-channel gate array) — so
      // retrying 'both' would ALSO re-touch the timed-out email leg. The
      // conservative choice gates the entire offer behind typed-yes rather
      // than trusting the sms-side "confirmed rejection" half alone.
      expect(outcome.retryChannel).toBe('both');
      expect(outcome.retryGate).toBe('typed-yes');
      expect(outcome.retryPrompt).toBe(
        'This attempt included a timeout — the customer MAY already have that message. Any channel that failed outright did NOT arrive. Type YES to redeliver email + text now:',
      );
    });

    it('502 mixed in the OTHER order (timeout first, plain second) — .includes catches it regardless of position, same honest prompt', () => {
      const mixedError = `${DELIVERY_TIMEOUT_ERROR_PREFIX}delivery outcome unknown (GHL may have still delivered it): sms socket reset; Email rejected (400)`;
      const outcome = decideSendOutcome(
        false,
        { code: 'delivery-failed', error: mixedError, failedChannels: ['sms', 'email'] },
        'both',
        false,
      );
      expect(outcome.retryGate).toBe('typed-yes');
      expect(outcome.retryPrompt).toBe(
        'This attempt included a timeout — the customer MAY already have that message. Any channel that failed outright did NOT arrive. Type YES to redeliver email + text now:',
      );
    });

    it('retry-still-fails on a timeout-hedged channel keeps typed-yes, "again" wording (isRetry:true)', () => {
      const outcome = decideSendOutcome(
        false,
        {
          code: 'delivery-failed',
          error: `${DELIVERY_TIMEOUT_ERROR_PREFIX}delivery outcome unknown (GHL may have still delivered it): still timing out`,
          failedChannels: ['sms'],
        },
        'sms',
        true,
      );
      expect(outcome.retryGate).toBe('typed-yes');
      expect(outcome.retryPrompt).toBe(
        'This attempt included a timeout — the customer MAY already have that message. Any channel that failed outright did NOT arrive. Type YES to redeliver text again:',
      );
    });
  });

  it('non-delivery failure (e.g. empty-quote/no-contact/view-only) — surfaces body.error, no retry offered', () => {
    const outcome = decideSendOutcome(
      false,
      { error: 'Add at least one priced line item and calculate the quote before sending.', code: 'empty-quote' },
      'both',
      false,
    );
    expect(outcome.message).toBe('Add at least one priced line item and calculate the quote before sending.');
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryPrompt).toBeNull();
    expect(outcome.retryGate).toBeNull();
  });

  it('non-delivery failure with no body.error falls back to a generic message', () => {
    const outcome = decideSendOutcome(false, {}, 'both', false);
    expect(outcome.message).toBe('Action failed');
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryGate).toBeNull();
  });

  // #270 fix round, FIX 5b (technical LOW): a retry is reachable on a
  // non-delivery-failure 400 too — e.g. the HighLevel contact link got
  // cleared between the original send and the ?retryDelivery=1 click, so
  // the retry hits the same no-contact guard the route applies to every
  // send. isRetry:true changes nothing here (still not delivery-related,
  // still not retryable) — pinned explicitly since this exact isRetry:true
  // + non-delivery-failure combination had no prior coverage.
  it('non-delivery failure reached via a RETRY (isRetry:true) — same generic handling, no retry offered', () => {
    const outcome = decideSendOutcome(
      false,
      { error: 'No linked HighLevel contact — link one before sending.', code: 'no-contact' },
      'sms',
      true,
    );
    expect(outcome.message).toBe('No linked HighLevel contact — link one before sending.');
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryPrompt).toBeNull();
    expect(outcome.retryGate).toBeNull();
  });

  // #270 fix round, FIX 3 + FIX 4 (customer MED + LOW): this branch used to
  // pair a plain window.confirm with "...deliver <channel> again now?" —
  // both wrong. See RetryGate's doc comment (pipelineSendOutcome.ts) for the
  // reflex-Enter risk a plain confirm chained onto this case's preceding
  // alert() (a customer who already has the quote could get a REAL
  // duplicate send from Enter-Enter); see decideSendOutcome's alreadySent
  // branch for why "again" is wrong (quote_sent_at is channel-agnostic — the
  // clicked channel may never have been attempted even once).
  it('alreadySent on a FRESH send — no extra message (caller keeps its own "(already sent earlier)" line), offers a TYPED-YES-gated redeliver for the clicked channel, channel-history-neutral wording', () => {
    const outcome = decideSendOutcome(true, { alreadySent: true }, 'sms', false);
    expect(outcome.message).toBe('');
    expect(outcome.retryChannel).toBe('sms');
    expect(outcome.retryPrompt).toBe(
      'This quote was already sent earlier and the customer may already have it. Type YES to send text for this quote now:',
    );
    expect(outcome.retryGate).toBe('typed-yes');
  });

  it('alreadySent on a fresh send for a "both" click offers a typed-yes redeliver for both, channel-history-neutral wording', () => {
    const outcome = decideSendOutcome(true, { alreadySent: true }, 'both', false);
    expect(outcome.retryChannel).toBe('both');
    expect(outcome.retryPrompt).toBe(
      'This quote was already sent earlier and the customer may already have it. Type YES to send email + text for this quote now:',
    );
    expect(outcome.retryGate).toBe('typed-yes');
  });

  it('retry-answers-alreadySent — the quote moved on since the original send; says so plainly and drops the retry offer (#241 defect 2 idiom)', () => {
    const outcome = decideSendOutcome(true, { alreadySent: true }, 'both', true);
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryPrompt).toBeNull();
    expect(outcome.retryGate).toBeNull();
    expect(outcome.message).toContain('moved past');
  });

  it('retry-still-fails (partial: one of two retried channels still failing) — says still failed, offers another CONFIRM-gated retry', () => {
    const outcome = decideSendOutcome(true, { failedChannels: ['email'] }, 'both', true);
    expect(outcome.message).toBe('EMAIL failed. The other requested channel was delivered.');
    expect(outcome.retryChannel).toBe('email');
    expect(outcome.retryPrompt).toBe('Redeliver email again?');
    expect(outcome.retryGate).toBe('confirm');
  });

  it('retry-still-fails (all channels, 502 again) — distinct "still not delivered" wording, offers another CONFIRM-gated retry', () => {
    const outcome = decideSendOutcome(
      false,
      { code: 'delivery-failed', error: 'still down', failedChannels: ['sms', 'email'] },
      'both',
      true,
    );
    expect(outcome.message).toBe('Still not delivered. (still down)');
    expect(outcome.retryChannel).toBe('both');
    expect(outcome.retryPrompt).toBe('Redeliver email + text again?');
    expect(outcome.retryGate).toBe('confirm');
  });

  it('retry succeeds fully — says delivered, no further retry offered', () => {
    const outcome = decideSendOutcome(true, { failedChannels: [] }, 'sms', true);
    expect(outcome.message).toBe('Delivered.');
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryPrompt).toBeNull();
    expect(outcome.retryGate).toBeNull();
  });

  it('ignores non-channel junk in failedChannels (defensive narrowing)', () => {
    const outcome = decideSendOutcome(true, { failedChannels: ['sms', 'bogus', null, 42] }, 'both', false);
    expect(outcome.retryChannel).toBe('sms');
  });

  // #270 fix round, FIX 5a (technical LOW): a hypothetical malformed
  // ['sms','sms'] (duplicate entries) must NOT be read as "both channels
  // failed" — toRetryChannel maps a 2-length array straight to 'both', so
  // without a dedupe this would wrongly offer a redeliver for BOTH channels
  // when only sms ever failed (and would wrongly claim email failed too, in
  // the partial-failure message text above it).
  it('dedupes failedChannels before mapping to a retry channel — a doubled sms entry stays "sms", never "both"', () => {
    const outcome = decideSendOutcome(true, { failedChannels: ['sms', 'sms'] }, 'both', false);
    expect(outcome.retryChannel).toBe('sms');
    expect(outcome.message).toBe('SMS failed. The other requested channel was delivered.');
  });
});
