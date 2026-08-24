import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { verifyTwilioSignature, isAllowedSender, runWhatsAppCommand } from './whatsapp';

// Finding 2 (PR #926 fix round 2): the WhatsApp 'prep' reply must flag a
// SHORT prep (the on-hand clamp bit) instead of reading identically to a
// full one. listFulfillmentCards/prepareJobMaterials are mocked; the reply
// TEXT is what's under test here.
const { listFulfillmentCardsMock, prepareJobMaterialsMock } = vi.hoisted(() => ({
  listFulfillmentCardsMock: vi.fn(),
  prepareJobMaterialsMock: vi.fn(),
}));
vi.mock('@/lib/inventory/jobs', () => ({
  listFulfillmentCards: listFulfillmentCardsMock,
  setJobFulfillmentStage: vi.fn(),
  prepareJobMaterials: prepareJobMaterialsMock,
}));

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

describe("runWhatsAppCommand 'prep' — Finding 2 (fix round 2): a short prep must not read like a full one", () => {
  const card = { id: 'j1', jobNumber: 42, customerName: 'Test Customer' };

  it('reports a plain success with no short-SKU note when nothing was short', async () => {
    listFulfillmentCardsMock.mockResolvedValueOnce([card]);
    prepareJobMaterialsMock.mockResolvedValueOnce({
      ok: true,
      alreadyDone: false,
      deductions: [{ sku: 'SKU-A', before: 10, deducted: 2, after: 8 }],
      short: [],
    });
    const reply = await runWhatsAppCommand({ kind: 'prep', jobNumber: 42 });
    expect(reply).toBe('Job #42 prepped — deducted 1 SKU from stock. Now Ready For Install.');
  });

  it('appends a SHORT flag naming the clamped SKUs when the on-hand floor bit', async () => {
    listFulfillmentCardsMock.mockResolvedValueOnce([card]);
    prepareJobMaterialsMock.mockResolvedValueOnce({
      ok: true,
      alreadyDone: false,
      deductions: [{ sku: 'SKU-A', before: 1, deducted: 1, after: 0 }],
      short: ['SKU-A'],
    });
    const reply = await runWhatsAppCommand({ kind: 'prep', jobNumber: 42 });
    expect(reply).toContain('Job #42 prepped — deducted 1 SKU from stock. Now Ready For Install.');
    expect(reply).toMatch(/SHORT on 1 SKU/i);
    expect(reply).toContain('SKU-A');
  });
});
