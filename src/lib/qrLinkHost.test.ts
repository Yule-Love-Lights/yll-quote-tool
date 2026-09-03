import { describe, it, expect } from 'vitest';
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp';
import { QR_LINK_HOST_REDIRECTS } from '../../next.config';
import { QR_DESTINATION } from './qrRedirect';

// The redirect that sweeps every non-/qr path on link.yulelovelights.com to the
// marketing site carries a negative lookahead, and getting it wrong is not a
// cosmetic failure: a pattern one character too greedy swallows /qr itself, and
// every printed QR code silently loses its destination and its attribution.
//
// So this compiles the ACTUAL source string with the SAME path-to-regexp Next
// bundles and matches real paths against it, rather than asserting that the
// config object has the right shape. Shape tests pass against a broken regex.

const [sweep] = QR_LINK_HOST_REDIRECTS;

const matches = (source: string, path: string) => pathToRegexp(source).test(path);

describe('the link-host sweep', () => {
  it('is scoped to the QR subdomain and nowhere else', () => {
    for (const rule of QR_LINK_HOST_REDIRECTS) {
      expect(rule.has).toEqual([{ type: 'host', value: 'link.yulelovelights.com' }]);
      // Temporary, deliberately: a permanent redirect is cached effectively
      // forever and would freeze a decision we may want to revisit.
      expect(rule.permanent).toBe(false);
    }
  });

  // The marketing site is written as a literal in BOTH next.config.ts and
  // src/lib/qrRedirect.ts, because importing app code into the build config to
  // share a value that changes about never is the worse trade. This is what
  // stops that being two sources of truth: the origin and path have to agree,
  // and a drift fails here loudly rather than quietly splitting the destination
  // in two. Raised by the pre-merge admin lens on PR #1191.
  it('sends legacy links to the same place the QR codes go', () => {
    const swept = new URL(sweep!.destination);
    const qr = new URL(QR_DESTINATION);
    expect(swept.origin + swept.pathname).toBe(qr.origin + qr.pathname);
  });

  // Untagged, this traffic is indistinguishable from ordinary homepage visits,
  // and the question the sweep raises - is anyone still following the old
  // GoHighLevel links - becomes unanswerable. The /qr route tags every scan; so
  // does this.
  it('tags the swept traffic so it can be counted', () => {
    const swept = new URL(sweep!.destination);
    expect(swept.searchParams.get('utm_source')).toBe('legacy_link');
    expect(swept.searchParams.get('utm_medium')).toBe('redirect');
    // Not a QR scan: these are old links, and labelling them 'qr' would put a
    // fiction into the same report the printed codes are measured in.
    expect(swept.searchParams.get('utm_source')).not.toBe('qr');
  });

  it('is exactly one rule, so a second one cannot drift from it', () => {
    expect(QR_LINK_HOST_REDIRECTS).toHaveLength(1);
    expect(sweep).toBeDefined();
  });

  // THE ONE THAT MATTERS. Every printed code must be left alone.
  it.each([
    '/qr',
    '/qr/hbJhlsQLHpFv',
    '/qr/DjzJS9mzhTOm',
    '/qr/aCodeWeHaveNeverSeen',
    '/qr/a/b',
    '/qr/',
  ])('leaves %s for the QR route', (path) => {
    expect(matches(sweep!.source, path)).toBe(false);
  });

  // Everything else on that host is a GoHighLevel-era link and goes to the site.
  it.each([
    '/appointment/abc123',
    '/widget/form/xyz',
    '/review',
    '/qrcode',
    '/qr-code',
    '/some/deep/legacy/path',
  ])('sweeps %s to the marketing site', (path) => {
    expect(matches(sweep!.source, path)).toBe(true);
  });

  // Not obvious, and the reason there is only one rule: the first draft assumed
  // this pattern would NOT match the bare root and carried a second rule for it.
  // Compiling the real regex said otherwise.
  it('covers the bare root of the host as well', () => {
    expect(matches(sweep!.source, '/')).toBe(true);
  });
});
