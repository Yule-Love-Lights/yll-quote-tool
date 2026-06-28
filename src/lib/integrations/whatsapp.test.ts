import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { verifyMetaSignature, isAllowedSender } from './whatsapp';

describe('verifyMetaSignature (#82 Phase 3)', () => {
  const secret = 'app-secret-123';
  const body = JSON.stringify({ hello: 'world' });
  const goodSig = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  it('accepts a correct signature', () => {
    expect(verifyMetaSignature(body, goodSig, secret)).toBe(true);
  });
  it('rejects a tampered body, wrong secret, or missing header/secret', () => {
    expect(verifyMetaSignature(body + 'x', goodSig, secret)).toBe(false);
    expect(verifyMetaSignature(body, goodSig, 'other-secret')).toBe(false);
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
    expect(verifyMetaSignature(body, goodSig, undefined)).toBe(false);
  });
});

describe('isAllowedSender', () => {
  const prev = process.env.WHATSAPP_ALLOWED_NUMBERS;
  afterEach(() => {
    if (prev === undefined) delete process.env.WHATSAPP_ALLOWED_NUMBERS;
    else process.env.WHATSAPP_ALLOWED_NUMBERS = prev;
  });

  it('matches allowlisted numbers ignoring formatting; fails closed when unset/empty', () => {
    delete process.env.WHATSAPP_ALLOWED_NUMBERS;
    expect(isAllowedSender('16315170186')).toBe(false); // no allowlist ⇒ none

    process.env.WHATSAPP_ALLOWED_NUMBERS = '+1 (631) 517-0186, 15551234567';
    expect(isAllowedSender('16315170186')).toBe(true); // formatting stripped both sides
    expect(isAllowedSender('+1 631 517 0186')).toBe(true);
    expect(isAllowedSender('19998887777')).toBe(false);
    expect(isAllowedSender(undefined)).toBe(false);
  });
});
