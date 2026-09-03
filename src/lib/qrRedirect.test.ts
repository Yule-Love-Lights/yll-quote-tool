import { describe, it, expect } from 'vitest';
import { buildQrDestination, QR_DESTINATION } from './qrRedirect';

// The two slugs below are REAL codes off real printed material Naldo scanned on
// 2026-09-03 (a business card each). They are the regression anchors for this
// whole route: if either of these ever stops resolving to a usable page, a
// customer standing in front of a card gets nothing.
const REAL_CARD_SLUGS = ['hbJhlsQLHpFv', 'DjzJS9mzhTOm'];

describe('buildQrDestination', () => {
  it('sends the two real printed card codes to the destination, tagged', () => {
    for (const slug of REAL_CARD_SLUGS) {
      const url = new URL(buildQrDestination(slug));
      expect(url.origin + url.pathname).toBe(QR_DESTINATION);
      expect(url.searchParams.get('utm_content')).toBe(slug);
      expect(url.searchParams.get('utm_source')).toBe('qr');
      expect(url.searchParams.get('utm_medium')).toBe('print');
    }
  });

  // The whole point of the route: we do NOT have the old slug list, so a code
  // nobody has ever seen is the ordinary case and must still land somewhere.
  it('still redirects an unknown slug rather than failing it', () => {
    const url = new URL(buildQrDestination('neverSeenBefore99'));
    expect(url.origin + url.pathname).toBe(QR_DESTINATION);
    expect(url.searchParams.get('utm_content')).toBe('neverSeenBefore99');
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
    const raw = buildQrDestination(slug as string | undefined | null);
    const url = new URL(raw);
    // Still a usable absolute URL on OUR host - a malformed code must never be
    // able to steer the scan somewhere else, and must never produce an error.
    expect(url.origin + url.pathname).toBe(QR_DESTINATION);
    expect(url.searchParams.has('utm_content')).toBe(false);
    // The tracking tags survive so the scan is still counted as a QR scan.
    expect(url.searchParams.get('utm_source')).toBe('qr');
  });

  it('always returns an absolute URL on the destination host', () => {
    const host = new URL(QR_DESTINATION).host;
    for (const slug of [...REAL_CARD_SLUGS, '', 'x', '../..', 'a'.repeat(200)]) {
      expect(new URL(buildQrDestination(slug)).host).toBe(host);
    }
  });

  it('is a plain function with no throwing branch', () => {
    // Guards the fail-open contract: analytics tagging must never be able to
    // cost someone their scan.
    for (const slug of ['', '%%%', ' ', 'ok', undefined, null]) {
      expect(() => buildQrDestination(slug as string | undefined | null)).not.toThrow();
    }
  });
});
