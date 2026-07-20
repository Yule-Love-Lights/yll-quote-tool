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

export const metadata: Metadata = {
  title: 'Instant Holiday Lighting Estimate | Yule Love Lights',
  description:
    'Type your address and see a real holiday lighting price for your home in seconds. No photos, no waiting.',
  robots: { index: false, follow: false },
};

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
