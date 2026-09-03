import type { NextConfig } from "next";

// Baseline HTTP security headers applied to every response. Conservative set —
// no CSP yet (that needs a per-source allowlist pass so it doesn't break the
// Konva canvas, next/image, and the Google embeds; tracked as a follow-up).
// Referrer-Policy is the important one for this app: the customer portal's only
// token is the bare quote UUID in the path, so a permissive Referer would leak
// it to third parties (e.g. the Google satellite <img>). strict-origin-when-
// cross-origin sends only the origin off-site, never the path. Audit 2026-06.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

// The printed-QR subdomain. link.yulelovelights.com used to be a GoHighLevel
// link host run by a former agency; it now points at this app so the QR codes on
// the van decal and the business cards resolve again (src/app/qr).
//
// Only /qr is ours. Every OTHER path on that host is a link from the GoHighLevel
// era - a booking confirmation, a review request - that may still be sitting in a
// customer's texts or inbox. Before the domain moved, those returned a plain 404.
// Pointed at this app they hit the operator gate instead, which answers a
// signed-out request with the STAFF LOGIN PAGE: a homeowner following an old link
// gets an "Operator / Password" form on a Yule Love Lights subdomain, which reads
// as a phishing page and is strictly worse than the 404 it replaced. Found by the
// close review's customer lens, measured, 2026-09-03.
//
// So everything on that host except /qr goes to the marketing site. Temporary, not
// permanent: the same reasoning as the 302 in the /qr route itself - a permanent
// redirect is cached by browsers effectively forever and would freeze a decision
// we may want to revisit if any of those legacy paths turns out to be worth
// serving properly.
const QR_LINK_HOST = 'link.yulelovelights.com';
const MARKETING_SITE = 'https://yulelovelights.com/';

// Exported so a test can compile these patterns with the SAME path-to-regexp Next
// uses, rather than asserting the config's shape and hoping the regex is right.
// The negative lookahead is the whole risk here: get it wrong and this rule eats
// the QR scans it exists to protect. See src/lib/qrLinkHost.test.ts.
//
// One rule is enough: the pattern matches the bare root of the host too. That
// was NOT obvious - the first draft carried a separate rule for '/' on the
// assumption it would not, and the test compiled the real regex and said
// otherwise. Kept as one rule rather than two that agree.
export const QR_LINK_HOST_REDIRECTS = [
  {
    source: '/:path((?!qr$|qr/).*)',
    has: [{ type: 'host' as const, value: QR_LINK_HOST }],
    destination: MARKETING_SITE,
    permanent: false,
  },
];

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS checkout. Without it, Turbopack sees the
  // parent repo's package-lock.json from inside a .claude/worktrees/* copy and
  // silently serves the MAIN checkout's code (whatever stale branch it's on)
  // while you edit the worktree — routes 404 with no error anywhere.
  turbopack: { root: __dirname },
  allowedDevOrigins: ['127.0.0.1'],
  async redirects() {
    return QR_LINK_HOST_REDIRECTS;
  },
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      // /estimate is the ONE route meant to be embedded — the self-serve
      // estimator runs inside an <iframe> on a yulelovelights.com page. The
      // baseline X-Frame-Options: SAMEORIGIN above would block that, so this
      // route also sends a CSP frame-ancestors allowlist, which browsers give
      // precedence over X-Frame-Options. Scoped to THIS path and to our own
      // marketing origins only — never a wildcard, and never the portal (its
      // URLs carry the quote UUID that is the customer's only access token, so
      // framing those anywhere would be a clickjacking + token-leak surface).
      // If a browser ignored frame-ancestors it would fall back to SAMEORIGIN
      // and simply refuse to frame — fails closed, never open.
      {
        source: '/estimate',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "frame-ancestors 'self' https://yulelovelights.com https://www.yulelovelights.com",
          },
        ],
      },
      // /forms/* are the non-lead website forms (#195) — newsletter signup, job
      // and intern applications, Light Up For Hope nominations. Same reasoning
      // and same allowlist as /estimate above: embedded on our own marketing
      // pages only, never a wildcard, never the portal. These pages carry no
      // access token and read no customer record; they only accept input.
      {
        source: '/forms/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "frame-ancestors 'self' https://yulelovelights.com https://www.yulelovelights.com",
          },
        ],
      },
    ];
  },
  images: {
    // The snowglobe InteractiveHero requests quality 85 for the full-bleed
    // hero; Next 16 requires every used quality to be allow-listed here.
    qualities: [75, 85],
    // Allowlist of external image hosts for next/image. Keep this list
    // tight — every new host has to be vetted (hotlink + privacy).
    remotePatterns: [
      {
        // Placeholder imagery for the customer portal mock quote +
        // gallery. Swap for a CDN (Cloudflare Images / Supabase
        // Storage / S3) once real renders + gallery photos land.
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
  },
};

export default nextConfig;
