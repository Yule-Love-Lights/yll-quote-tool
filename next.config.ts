import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
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
