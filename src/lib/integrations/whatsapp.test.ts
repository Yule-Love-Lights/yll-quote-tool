import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { verifyTwilioSignature, isAllowedSender } from './whatsapp';

describe('verifyTwilioSignature (#82 Phase 3, Twilio scheme)', () => {
  // Twilio: HMAC-SHA1(authToken, URL + concat(sortedKey + value)) → base64
  const token = 'auth-token-xyz';
  const url = 'https://quote.yulelovelights.com/api/integrations/whatsapp/webhook';
  const params = { From: 'whatsapp:+16315170186', Body: 'jobs', MessageSid: 'SM123' };
  const sortedConcat = Object.keys(params).sort().map((k) => k + (params as Record<string, string>)[k]).join('');
  const goodSig = crypto.createHmac('sha1', token).update(url + sortedConcat, 'utf8').digest('base64');

  it('accepts a correct signature', () => {
    expect(verifyTwilioSignature(url, params, goodSig, token)).toBe(true);
  });
  it('rejects a tampered param, wrong url, wrong token, or missing header/token', () => {
    expect(verifyTwilioSignature(url, { ...params, Body: 'tampered' }, goodSig, token)).toBe(false);
    expect(verifyTwilioSignature(url + '?x=1', params, goodSig, token)).toBe(false);
    expect(verifyTwilioSignature(url, params, goodSig, 'other-token')).toBe(false);
    expect(verifyTwilioSignature(url, params, null, token)).toBe(false);
    expect(verifyTwilioSignature(url, params, goodSig, undefined)).toBe(false);
  });
  it('is order-independent on params (sorts before hashing)', () => {
    // Build the same dict in different insertion order — signature must still match.
    const reordered: Record<string, string> = {};
    Object.keys(params).reverse().forEach((k) => (reordered[k] = (params as Record<string, string>)[k]));
    expect(verifyTwilioSignature(url, reordered, goodSig, token)).toBe(true);
  });
});

describe('isAllowedSender (Twilio whatsapp: prefix)', () => {
  const prev = process.env.WHATSAPP_ALLOWED_NUMBERS;
  afterEach(() => {
    if (prev === undefined) delete process.env.WHATSAPP_ALLOWED_NUMBERS;
    else process.env.WHATSAPP_ALLOWED_NUMBERS = prev;
  });

  it('matches allowlisted numbers ignoring the whatsapp: prefix + formatting', () => {
    process.env.WHATSAPP_ALLOWED_NUMBERS = '+1 (631) 517-0186, 15551234567';
    expect(isAllowedSender('whatsapp:+16315170186')).toBe(true); // strips whatsapp: + non-digits
    expect(isAllowedSender('whatsapp:+1 631 517 0186')).toBe(true);
    expect(isAllowedSender('whatsapp:+19998887777')).toBe(false);
    expect(isAllowedSender(undefined)).toBe(false);
  });
  it('fails closed when the allowlist env is unset/empty', () => {
    delete process.env.WHATSAPP_ALLOWED_NUMBERS;
    expect(isAllowedSender('whatsapp:+16315170186')).toBe(false);
  });
});
