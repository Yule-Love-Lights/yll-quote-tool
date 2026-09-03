import { describe, it, expect } from 'vitest';
import { buildQrDestination, QR_DESTINATION } from './qrRedirect';

// The two slugs below are the REAL printed codes, read off the old account's
// Sites -> QR Codes screen on 2026-09-03 and confirmed by Naldo against the
// physical items. That account is unpaid and can be purged at any time, after
// which this mapping is unrecoverable — so these tests are the durable record
// of it as much as they are a check.
const VAN = 'hbJhlsQLHpFv';
const BUSINESS_CARD = 'DjzJS9mzhTOm';

const HOMEPAGE = 'https://yulelovelights.com/';
const QUOTE_PAGE = 'https://yulelovelights.com/get-a-quote/';

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

  it('sends the business card to the QUOTE page, not the homepage', () => {
    const url = new URL(buildQrDestination(BUSINESS_CARD));
    expect(url.origin + url.pathname).toBe(QUOTE_PAGE);
    expect(url.searchParams.get('utm_campaign')).toBe('business_card');
    expect(url.searchParams.get('utm_content')).toBe(BUSINESS_CARD);
  });

  // The defect this pins is the easy one to ship by accident: collapsing both
  // printed codes onto one destination. The card is a lead-capture scan and the
  // van is a browse; treating them alike silently downgrades the code most
  // likely to be held by a homeowner who just asked for a price.
  it('does not collapse the two printed codes onto the same destination', () => {
    expect(originAndPath(buildQrDestination(VAN))).not.toBe(
      originAndPath(buildQrDestination(BUSINESS_CARD)),
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
