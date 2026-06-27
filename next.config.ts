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

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
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
