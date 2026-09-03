import { describe, it, expect } from 'vitest';
import { buildQrDestination, QR_DESTINATION } from './qrRedirect';

// The two slugs below are the REAL printed codes. They were verified on
// 2026-09-03 by requesting the old account's own white-label host directly,
// which still answers them:
//
//   link.surgecrm.ai/qr/hbJhlsQLHpFv    302 -> https://yulelovelights.com/
//   link.surgecrm.ai/qr/DjzJS9mzhTOm    302 -> https://yulelovelights.com/get-a-quote/
//
// That account is unpaid and belongs to a former agency, so it can be purged
// without notice, after which this mapping is unrecoverable. These tests are
// the durable record of it as much as they are a check.
const VAN = 'hbJhlsQLHpFv';
const BUSINESS_CARD = 'DjzJS9mzhTOm';

const HOMEPAGE = 'https://yulelovelights.com/';

const originAndPath = (raw: string) => {
  const url = new URL(raw);
  return url.origin + url.pathname;
};

describe('buildQrDestination', () => {
  it('sends the van decal to the homepage', () => {
    const url = new URL(buildQrDestination(VAN));
    expect(url.origin + url.pathname).toBe(HOMEPAGE);
    expect(url.searchParams.get('utm_campaign')).toBe('van');
    expect(url.searchParams.get('utm_content')).toBe(VAN);
    expect(url.searchParams.get('utm_source')).toBe('qr');
    expect(url.searchParams.get('utm_medium')).toBe('print');
  });

  // The card originally pointed at /get-a-quote/. That page dead-ends today (a
  // bare request 301s to the homepage), so sending the card there would have
  // reproduced the outage this route exists to fix. Naldo chose the homepage on
  // 2026-09-03. This test pins that the old destination is NOT resurrected by a
  // later well-meaning edit without someone first fixing the WordPress redirect.
  it('sends the business card to the homepage, not the dead /get-a-quote/ page', () => {
    const url = new URL(buildQrDestination(BUSINESS_CARD));
    expect(url.origin + url.pathname).toBe(HOMEPAGE);
    expect(url.pathname).not.toContain('get-a-quote');
    expect(url.searchParams.get('utm_campaign')).toBe('business_card');
    expect(url.searchParams.get('utm_content')).toBe(BUSINESS_CARD);
  });

  // Landing the two codes in the same place is a product decision, not an
  // accident, but it must not cost us the ability to tell them apart: the whole
  // point of capturing the mapping before the old account dies is knowing which
  // printed thing a scan came from.
  it('still reports the two printed codes as different campaigns', () => {
    const van = new URL(buildQrDestination(VAN));
    const card = new URL(buildQrDestination(BUSINESS_CARD));
    expect(originAndPath(van.toString())).toBe(originAndPath(card.toString()));
    expect(van.searchParams.get('utm_campaign')).not.toBe(
      card.searchParams.get('utm_campaign'),
    );
  });

  // We do NOT have a complete list and the source account may already be gone,
  // so an unrecognised code is an ordinary event that must still land somewhere.
  it('still redirects an unknown slug rather than failing it', () => {
    const url = new URL(buildQrDestination('neverSeenBefore99'));
    expect(url.origin + url.pathname).toBe(HOMEPAGE);
    expect(url.searchParams.get('utm_content')).toBe('neverSeenBefore99');
    // No campaign: we genuinely do not know what this code was for, and
    // guessing one would pollute the analytics it exists to serve.
    expect(url.searchParams.has('utm_campaign')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['undefined', undefined],
    ['null', null],
    ['path traversal', '../../etc/passwd'],
    ['a full URL', 'https://evil.example.com/'],
    ['spaces', 'two words'],
    ['over 64 chars', 'a'.repeat(65)],
    ['angle brackets', '<script>'],
  ])('degrades a %s slug to an untagged redirect, never a dead end', (_label, slug) => {
    const url = new URL(buildQrDestination(slug as string | undefined | null));
    // Still a usable absolute URL on OUR host - a malformed code must never be
    // able to steer the scan somewhere else, and must never produce an error.
    expect(url.origin + url.pathname).toBe(HOMEPAGE);
    expect(url.searchParams.has('utm_content')).toBe(false);
    expect(url.searchParams.has('utm_campaign')).toBe(false);
    // The tracking tags survive so the scan is still counted as a QR scan.
    expect(url.searchParams.get('utm_source')).toBe('qr');
  });

  // KNOWN_CAMPAIGNS is a plain object, so a bare bracket lookup walks
  // Object.prototype: 'constructor' returned a function and '__proto__' an
  // object, both of which then got stamped into utm_campaign on a PUBLIC route.
  // The technical lens reproduced it live before the Object.hasOwn guard landed
  // (/qr/constructor emitted utm_campaign=function Object() { [native code] }).
  it.each(['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'does not read %s off the prototype chain as a campaign',
    (slug) => {
      const url = new URL(buildQrDestination(slug));
      expect(url.origin + url.pathname).toBe(HOMEPAGE);
      expect(url.searchParams.has('utm_campaign')).toBe(false);
    },
  );

  it('never leaves the yulelovelights.com host, whatever the slug', () => {
    const host = new URL(QR_DESTINATION).host;
    const slugs = [VAN, BUSINESS_CARD, '', 'x', '../..', 'a'.repeat(200), 'https://evil.test/'];
    for (const slug of slugs) {
      expect(new URL(buildQrDestination(slug)).host).toBe(host);
    }
  });

  it('is a plain function with no throwing branch', () => {
    // Guards the fail-open contract: analytics tagging must never be able to
    // cost someone their scan.
    for (const slug of ['', '%%%', ' ', 'ok', VAN, undefined, null]) {
      expect(() => buildQrDestination(slug as string | undefined | null)).not.toThrow();
    }
  });
});
