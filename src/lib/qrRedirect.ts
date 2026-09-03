// Legacy printed-QR redirector (broken-link regression, 2026-09-03).
//
// Every QR code Yule Love Lights has ever printed - the van decal and the
// business cards - points at https://link.yulelovelights.com/qr/<slug>. That
// subdomain used to be served by a GoHighLevel account opened by a former
// agency. When that account lapsed, GHL detached the custom domain and fell
// back to the agency's own white-label host (link.surgecrm.ai), so the printed
// codes stopped resolving. The slugs themselves never changed, which is the
// only reason the printed material is recoverable at all.
//
// Two properties here are load-bearing. Both are the reason this is a module
// with tests rather than three lines inlined in the route.
//
// 1. It NEVER fails a scan. A code that is not in the table below still lands
//    on the website rather than an error page. The old account is unpaid and
//    can be purged at any time by someone who does not work here, so the table
//    is a best-known-mapping, not a guest list - anything missing from it still
//    belongs to a real person holding a real card.
//
// 2. The caller redirects 302, never 301. A 301 is cached by browsers and by
//    QR scanner apps effectively forever, which would silently freeze the
//    destination for exactly the people who already scanned - and freezing the
//    destination is the one thing this route exists to prevent. "Temporary" is
//    correct even though the route itself is permanent.
//
// Scans are tagged with UTM parameters so they are attributable in the
// analytics already running on the marketing site, with no new table and no
// server-side capture (src/lib/analytics/posthog.ts is browser-only and cannot
// fire from a redirect that renders no page).

// Where a scan lands when we do not recognise the code. Deliberately the
// homepage rather than a 404: see property 1 above.
export const QR_DESTINATION = 'https://yulelovelights.com/';

type KnownCode = {
  /** Absolute URL this printed code was originally pointing at. */
  destination: string;
  /** Human-readable utm_campaign, so analytics reads "van" not "hbJhlsQLHpFv". */
  campaign: string;
};

// The complete inventory, read off the old account's own Sites -> QR Codes
// screen on 2026-09-03 and confirmed by Naldo against the physical items.
// There were exactly two, and capturing them here is the whole point of this
// change: once that account is purged this mapping is unrecoverable.
//
// Note the two do NOT share a destination, which is easy to get wrong. The
// card was always a lead-capture scan, not a browse - sending it to the
// homepage would quietly downgrade the one code most likely to be held by a
// homeowner who just asked for a price.
const KNOWN_CODES: Record<string, KnownCode> = {
  hbJhlsQLHpFv: {
    destination: 'https://yulelovelights.com/',
    campaign: 'van',
  },
  DjzJS9mzhTOm: {
    destination: 'https://yulelovelights.com/get-a-quote/',
    campaign: 'business_card',
  },
};

// The observed legacy slugs are 12 chars of mixed-case alphanumerics. This is
// deliberately wider than that: we do not control the old generator and never
// saw its full alphabet, so the shape is a TAGGING gate, not an access gate.
// Anything outside it still redirects, just untagged - see buildQrDestination.
const TRACKABLE_SLUG = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build the absolute URL a scanned QR code should land on.
 *
 * A known code goes to its original destination. Everything else - unknown,
 * malformed, hostile, or absent - degrades to the homepage rather than
 * throwing or 404ing, because a dead end is the failure this whole route
 * exists to remove.
 */
export function buildQrDestination(slug: string | undefined | null): string {
  const known = typeof slug === 'string' ? KNOWN_CODES[slug] : undefined;
  const url = new URL(known?.destination ?? QR_DESTINATION);
  url.searchParams.set('utm_source', 'qr');
  url.searchParams.set('utm_medium', 'print');
  if (known) url.searchParams.set('utm_campaign', known.campaign);
  // Only reflect a slug we recognise the shape of. It flows into analytics
  // dashboards and server logs from here, so an arbitrary path segment does not
  // get to ride along - but failing the check costs the tag, never the redirect.
  if (typeof slug === 'string' && TRACKABLE_SLUG.test(slug)) {
    url.searchParams.set('utm_content', slug);
  }
  return url.toString();
}
