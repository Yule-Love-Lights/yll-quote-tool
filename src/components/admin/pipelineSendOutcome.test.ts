// src/components/admin/pipelineSendOutcome.test.ts
// Row 270: decideSendOutcome is the pure response -> decision core behind
// PipelineActionsMenu's 'send' case — see that file's helper doc comment for
// why one function classifies both a fresh send and a ?retryDelivery=1 retry.
import { describe, it, expect } from 'vitest';
import { decideSendOutcome } from './pipelineSendOutcome';

describe('decideSendOutcome', () => {
  it('full success (both channels delivered) — no extra message, no retry offered', () => {
    expect(decideSendOutcome(true, { failedChannels: [] }, 'both', false)).toEqual({
      message: '',
      retryChannel: null,
      retryPrompt: null,
    });
  });

  it('failedChannels missing entirely (not an array) is treated as no failures', () => {
    expect(decideSendOutcome(true, {}, 'both', false)).toEqual({
      message: '',
      retryChannel: null,
      retryPrompt: null,
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
  });

  it('200 partial failure (one of two requested channels failed) — honest message + offers retry for the failed channel', () => {
    const outcome = decideSendOutcome(
      true,
      { failedChannels: ['sms'], messageError: 'rate limited' },
      'both',
      false,
    );
    expect(outcome.message).toBe('SMS failed. The other requested channel was delivered. (rate limited)');
    expect(outcome.retryChannel).toBe('sms');
    expect(outcome.retryPrompt).toBe('Redeliver text now?');
  });

  it('200 partial failure with no messageError omits the parenthetical', () => {
    const outcome = decideSendOutcome(true, { failedChannels: ['email'] }, 'both', false);
    expect(outcome.message).toBe('EMAIL failed. The other requested channel was delivered.');
    expect(outcome.retryPrompt).toBe('Redeliver email now?');
  });

  it('502 all-requested-channels-failed (delivery-failed) — says the quote was marked sent locally, offers retry', () => {
    const outcome = decideSendOutcome(
      false,
      { code: 'delivery-failed', error: 'HighLevel unreachable', failedChannels: ['sms', 'email'] },
      'both',
      false,
    );
    expect(outcome.message).toBe('Quote marked sent, but no message was delivered. (HighLevel unreachable)');
    expect(outcome.retryChannel).toBe('both');
    expect(outcome.retryPrompt).toBe('Redeliver email + text now?');
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
  });

  it('502 with failedChannels missing falls back to the requested channel', () => {
    const outcome = decideSendOutcome(false, { code: 'delivery-failed', error: 'boom' }, 'email', false);
    expect(outcome.retryChannel).toBe('email');
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
  });

  it('non-delivery failure with no body.error falls back to a generic message', () => {
    const outcome = decideSendOutcome(false, {}, 'both', false);
    expect(outcome.message).toBe('Action failed');
    expect(outcome.retryChannel).toBeNull();
  });

  it('alreadySent on a FRESH send — no extra message (caller keeps its own "(already sent earlier)" line), offers a redeliver for the clicked channel', () => {
    const outcome = decideSendOutcome(true, { alreadySent: true }, 'sms', false);
    expect(outcome.message).toBe('');
    expect(outcome.retryChannel).toBe('sms');
    expect(outcome.retryPrompt).toBe('No new message was sent — deliver text again now?');
  });

  it('alreadySent on a fresh send for a "both" click offers redeliver for both', () => {
    const outcome = decideSendOutcome(true, { alreadySent: true }, 'both', false);
    expect(outcome.retryChannel).toBe('both');
    expect(outcome.retryPrompt).toBe('No new message was sent — deliver email + text again now?');
  });

  it('retry-answers-alreadySent — the quote moved on since the original send; says so plainly and drops the retry offer (#241 defect 2 idiom)', () => {
    const outcome = decideSendOutcome(true, { alreadySent: true }, 'both', true);
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryPrompt).toBeNull();
    expect(outcome.message).toContain('moved past');
  });

  it('retry-still-fails (partial: one of two retried channels still failing) — says still failed, offers another retry', () => {
    const outcome = decideSendOutcome(true, { failedChannels: ['email'] }, 'both', true);
    expect(outcome.message).toBe('EMAIL failed. The other requested channel was delivered.');
    expect(outcome.retryChannel).toBe('email');
    expect(outcome.retryPrompt).toBe('Redeliver email again?');
  });

  it('retry-still-fails (all channels, 502 again) — distinct "still not delivered" wording, offers another retry', () => {
    const outcome = decideSendOutcome(
      false,
      { code: 'delivery-failed', error: 'still down', failedChannels: ['sms', 'email'] },
      'both',
      true,
    );
    expect(outcome.message).toBe('Still not delivered. (still down)');
    expect(outcome.retryChannel).toBe('both');
    expect(outcome.retryPrompt).toBe('Redeliver email + text again?');
  });

  it('retry succeeds fully — says delivered, no further retry offered', () => {
    const outcome = decideSendOutcome(true, { failedChannels: [] }, 'sms', true);
    expect(outcome.message).toBe('Delivered.');
    expect(outcome.retryChannel).toBeNull();
    expect(outcome.retryPrompt).toBeNull();
  });

  it('ignores non-channel junk in failedChannels (defensive narrowing)', () => {
    const outcome = decideSendOutcome(true, { failedChannels: ['sms', 'bogus', null, 42] }, 'both', false);
    expect(outcome.retryChannel).toBe('sms');
  });
});
