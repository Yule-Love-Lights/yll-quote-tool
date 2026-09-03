// Legacy printed-QR redirector (broken-link regression, 2026-09-03).
//
// Every QR code Yule Love Lights has ever printed - the van decal and the
// business cards - points at https://link.yulelovelights.com/qr/<slug>. That
// subdomain used to be served by a GoHighLevel account opened by a former
// agency, white-labelled as SurgeCRM. The custom domain is no longer attached
// to that account, so link.yulelovelights.com now resolves to the SiteGround
// marketing site (35.212.83.65, same IP as the apex and www), which has no
// /qr/ route and answers every printed code with a 404.
//
// The account itself is NOT gone. Verified 2026-09-03 by request, not by
// screenshot: the agency's own white-label host still answers both slugs.
//
//   link.surgecrm.ai/qr/hbJhlsQLHpFv    302 -> https://yulelovelights.com/
//   link.surgecrm.ai/qr/DjzJS9mzhTOm    302 -> https://yulelovelights.com/get-a-quote/
//   link.surgecrm.ai/qr/<unknown>       404
//
// Those two lines are the durable record of what the printed codes originally
// meant. The account is unpaid and belongs to someone who does not work here,
// so it can be purged without notice and this mapping is unrecoverable when it
// is. That is the reason it is written down here and pinned by a test.
//
// Two properties are load-bearing. Both are why this is a module with tests
// rather than three lines inlined in the route.
//
// 1. It NEVER fails a scan. A code that is not in the table below still lands
//    on the website rather than an error page. This is a deliberate divergence
//    from the old system, which 404'd unknown slugs: our list of printed codes
//    is a best-known mapping, not a guest list, and anything missing from it is
//    still a real person holding a real card.
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

// Every scan lands here, known code or not.
//
// The business card originally pointed at /get-a-quote/ and deliberately does
// NOT any more. That page is published in WordPress (id 1185) but a redirect
// rule overrides it: a bare request 301s to the homepage, and only a request
// carrying a query string reaches /services/residential-holiday-lighting/. So
// the card's original destination is a dead end today whichever way it lands,
// and reproducing it faithfully would have reproduced the outage. Naldo's call
// on 2026-09-03 was to send both printed codes to the homepage. The two are
// still tagged apart below, so the card is not lost in the analytics - only in
// the landing page.
export const QR_DESTINATION = 'https://yulelovelights.com/';

// The complete inventory of printed codes, with the utm_campaign each one is
// reported under so analytics reads "business_card" and not "DjzJS9mzhTOm".
// There are exactly two.
const KNOWN_CAMPAIGNS: Record<string, string> = {
  hbJhlsQLHpFv: 'van',
  DjzJS9mzhTOm: 'business_card',
};

// The observed legacy slugs are 12 chars of mixed-case alphanumerics. This is
// deliberately wider than that: we do not control the old generator and never
// saw its full alphabet, so the shape is a TAGGING gate, not an access gate.
// Anything outside it still redirects, just untagged - see buildQrDestination.
const TRACKABLE_SLUG = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build the absolute URL a scanned QR code should land on.
 *
 * Every slug - known, unknown, malformed, hostile or absent - resolves to the
 * marketing homepage. A recognised code carries its campaign tag; everything
 * else is untagged. Nothing throws and nothing 404s, because a dead end is the
 * failure this whole route exists to remove.
 */
export function buildQrDestination(slug: string | undefined | null): string {
  const campaign = typeof slug === 'string' ? KNOWN_CAMPAIGNS[slug] : undefined;
  const url = new URL(QR_DESTINATION);
  url.searchParams.set('utm_source', 'qr');
  url.searchParams.set('utm_medium', 'print');
  if (campaign) url.searchParams.set('utm_campaign', campaign);
  // Only reflect a slug we recognise the shape of. It flows into analytics
  // dashboards and server logs from here, so an arbitrary path segment does not
  // get to ride along - but failing the check costs the tag, never the redirect.
  if (typeof slug === 'string' && TRACKABLE_SLUG.test(slug)) {
    url.searchParams.set('utm_content', slug);
  }
  return url.toString();
}
