// Customer self-serve estimate — public page (ledger self-serve, Phase A).
//
// The public "type your address, get an instant holiday-lighting range" front
// door. Server component: reads the SELF_SERVE_ESTIMATE_ENABLED flag at request
// time and 404s when off, so the whole feature stays dark in production until
// the flag is flipped. The interactive flow lives in the client component.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isSelfServeEstimateEnabled } from '@/lib/selfServe/estimateFlag';
import { EstimateFlow } from './EstimateFlow';

// The flag is a runtime server env read — never statically pre-render this page.
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ embed?: string }>;
}): Promise<Metadata> {
  const { embed } = await searchParams;
  // One canonical URL for the whole page, whatever query string got you here.
  // The standalone page is the rankable one, so ?embed=1 and any campaign or
  // referral parameters all point back at the bare /estimate instead of indexing
  // as separate thin duplicates. Same PORTAL_BASE_URL idiom the payment routes
  // use; the fallback is a literal because a page has no request object.
  const base = (process.env.PORTAL_BASE_URL || 'https://quote.yulelovelights.com').replace(/\/+$/, '');
  return {
    title: 'Instant Holiday Lighting Estimate | Yule Love Lights',
    description:
      "Type your address and see a real holiday lighting price for your home in seconds — or upload a photo and we'll design it by hand.",
    // Standalone /estimate is a rankable landing page (S48, Naldo's call). The
    // ?embed=1 variant is chrome-less and only ever lives inside the
    // yulelovelights.com iframe, so keep it OUT of the index — otherwise Googlebot
    // (which renders pages and can discover iframe src URLs) could rank the bare
    // embedded variant as a thin duplicate of the standalone page.
    robots: embed === '1' ? { index: false, follow: false } : { index: true, follow: true },
    alternates: { canonical: `${base}/estimate` },
  };
}

export default async function EstimatePage({
  searchParams,
}: {
  searchParams: Promise<{ embed?: string }>;
}) {
  if (!isSelfServeEstimateEnabled()) notFound();
  // `?embed=1` — rendered inside the <iframe> on the yulelovelights.com page.
  // Drops the standalone page chrome (its own hero + full-viewport height), since
  // the WordPress page supplies the heading and the frame supplies the height.
  const { embed } = await searchParams;
  return <EstimateFlow embedded={embed === '1'} />;
}
