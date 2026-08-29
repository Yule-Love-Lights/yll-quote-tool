import { NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { listAdvertisingCampaigns } from '@/lib/advertising/campaigns';
import { campaignActivitySummary } from '@/lib/advertising/placements';

export const runtime = 'nodejs';

/**
 * GET /api/advertising/campaigns — the ACTIVE campaigns for the worker's
 * Campaigns screen and capture picker (Simple Crew replica): name, the
 * per-sign rate (what a pending sign is worth), and the card numbers —
 * last-photo time, photo count, distinct-worker count.
 */
export async function GET() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const campaigns = await listAdvertisingCampaigns();
  const activity = await campaignActivitySummary(campaigns.map((c) => c.id));
  return NextResponse.json({
    campaigns: campaigns.map((c) => {
      const a = activity.get(c.id);
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        notes: c.notes,
        rateCents: c.rateCents,
        photoCount: a?.photoCount ?? 0,
        workerCount: a?.workerCount ?? 0,
        lastPhotoAt: a?.lastPhotoAt ?? null,
      };
    }),
  });
}
