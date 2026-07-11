import { describe, it, expect } from 'vitest';
import { referralQrSvg } from './referralQr';

// Ledger #41 growth feature 2 — the `qrcode` package is a pure, deterministic
// generator (no network calls), so these run for real against it rather than
// mocking — the same guarantee the feature relies on (works under a strict
// CSP with no external service).

describe('referralQrSvg', () => {
  it('produces an inline SVG string for a referral link', async () => {
    const svg = await referralQrSvg('https://quote.yulelovelights.com/refer/ABCD1234');
    expect(svg).not.toBeNull();
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="100%"');
    expect(svg).toContain('height="100%"');
  });

  it('sanity: the encoded markup scales with the link length (more data -> more path data)', async () => {
    const shortLink = 'https://quote.yulelovelights.com/refer/AAAAAAAA';
    const longLink =
      'https://quote.yulelovelights.com/refer/AAAAAAAA?utm_source=very-long-tracking-param-to-force-a-bigger-qr-version-and-more-encoded-modules';
    const shortSvg = await referralQrSvg(shortLink);
    const longSvg = await referralQrSvg(longLink);
    expect(shortSvg).not.toBeNull();
    expect(longSvg).not.toBeNull();
    expect(longSvg!.length).toBeGreaterThan(shortSvg!.length);
  });

  it('two different links encode to two different SVGs', async () => {
    const a = await referralQrSvg('https://quote.yulelovelights.com/refer/AAAAAAAA');
    const b = await referralQrSvg('https://quote.yulelovelights.com/refer/BBBBBBBB');
    expect(a).not.toEqual(b);
  });

  it('returns null for an empty link without calling the generator', async () => {
    expect(await referralQrSvg('')).toBeNull();
  });
});
