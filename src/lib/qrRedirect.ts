// Legacy printed-QR redirector (broken-link regression, 2026-09-03).
//
// Every QR code Yule Love Lights has ever printed - truck decals, business
// cards, flyers - points at https://link.yulelovelights.com/qr/<slug>. That
// subdomain used to be served by a GoHighLevel account opened by a former
// agency. It is no longer attached to that account or any other, so today
// every one of those codes dead-ends. Printed material cannot be recalled, so
// the fix has to live on a domain we own and answer for codes we have never
// seen and cannot enumerate.
//
// Two properties here are load-bearing. Both are the reason this is a module
// with tests rather than three lines inlined in the route.
//
// 1. It NEVER fails a scan. An unknown slug is the NORMAL case, not an error:
//    the slug -> destination map lived inside the old account and we do not
//    have it. A code we cannot identify still belongs to a real person holding
//    a real card, so it lands on the website rather than an error page. That
//    single property is what makes every card already in the world work again
//    the moment DNS moves, without anyone inventorying a single one of them.
//
// 2. The caller redirects 302, never 301. A 301 is cached by browsers and by
//    QR scanner apps effectively forever, which would silently freeze the
//    destination for exactly the people who already scanned - and freezing the
//    destination is the one thing this route exists to prevent. "Temporary" is
//    correct even though the route itself is permanent.
//
// The slug rides along as utm_content so scans are attributable in the
// analytics already running on the marketing site, with no new table and no
// server-side capture (src/lib/analytics/posthog.ts is browser-only and cannot
// fire from a redirect that renders no page).

// Where a scan lands. Naldo's call 2026-09-03: the marketing site for now,
// revisited once we recover what the old codes actually pointed at. Changing
// this is deliberately a one-line edit rather than a Settings field - Settings
// is Jason's area under the ownership table, and this is a value that changes
// once or twice, not weekly.
export const QR_DESTINATION = 'https://yulelovelights.com/';

// The observed legacy slugs are 12 chars of mixed-case alphanumerics
// (hbJhlsQLHpFv, DjzJS9mzhTOm). This is deliberately wider than that: we do not
// control the old generator and never saw its full alphabet, so the shape is a
// TAGGING gate, not an access gate. Anything outside it still redirects, just
// untagged - see buildQrDestination.
const TRACKABLE_SLUG = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build the absolute URL a scanned QR code should land on.
 *
 * Always returns a usable absolute URL. A missing, malformed, or hostile slug
 * degrades to the plain destination rather than throwing or 404ing, because a
 * dead end is the failure this whole route exists to remove.
 */
export function buildQrDestination(slug: string | undefined | null): string {
  const url = new URL(QR_DESTINATION);
  url.searchParams.set('utm_source', 'qr');
  url.searchParams.set('utm_medium', 'print');
  // Only reflect a slug we recognise the shape of. It flows into analytics
  // dashboards and server logs from here, so an arbitrary path segment does not
  // get to ride along - but failing the check costs the tag, never the redirect.
  if (typeof slug === 'string' && TRACKABLE_SLUG.test(slug)) {
    url.searchParams.set('utm_content', slug);
  }
  return url.toString();
}
