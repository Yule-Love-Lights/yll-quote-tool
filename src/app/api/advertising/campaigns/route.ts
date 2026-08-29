import { NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { listAdvertisingCampaigns } from '@/lib/advertising/campaigns';

export const runtime = 'nodejs';

/**
 * GET /api/advertising/campaigns — the ACTIVE campaigns for the capture
 * picker. The per-sign rate rides along so a worker's screen can show what a
 * pending sign is worth (the same number the pending estimate uses).
 */
export async function GET() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const campaigns = await listAdvertisingCampaigns();
  return NextResponse.json({
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, rateCents: c.rateCents })),
  });
}
