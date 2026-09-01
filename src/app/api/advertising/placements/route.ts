import { NextRequest, NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { listPlacements, type PlacementStatus } from '@/lib/advertising/placements';
import { handleCaptureSubmit } from '@/lib/advertising/captureSubmit';

export const runtime = 'nodejs';

/**
 * Worker capture + own-placements API (Simple Crew replica).
 *
 *   POST /api/advertising/placements — submit one placement (multipart, see
 *        captureSubmit.ts — the shared pipeline). Identity is FORCED from
 *        the session; nothing in the body can submit as someone else.
 *   GET  /api/advertising/placements — the caller's own placements, newest
 *        first, optional ?status= and ?campaignId= filters, each with a
 *        short-lived signed URL for its proof photo.
 */

const SIGNED_URL_SECONDS = 60 * 60;
const BUCKET = 'advertising-proof';

export async function POST(req: NextRequest) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }
  return handleCaptureSubmit(req, caller.worker);
}

const LISTABLE_STATUSES: ReadonlySet<string> = new Set(['pending', 'accepted', 'rejected', 'resubmitted']);

export async function GET(req: NextRequest) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const statusParam = req.nextUrl.searchParams.get('status') ?? '';
  const status = LISTABLE_STATUSES.has(statusParam) ? (statusParam as PlacementStatus) : undefined;
  const campaignId = req.nextUrl.searchParams.get('campaignId')?.trim() || undefined;

  // Scoped to the SESSION worker — a workerId query param is ignored.
  const placements = await listPlacements({ workerId: caller.worker.id, campaignId, status });

  const sb = getSupabaseServiceClient();
  const withPhotos = await Promise.all(
    placements.map(async (p) => {
      let photoUrl: string | null = null;
      if (sb && p.photoPath) {
        const { data } = await sb.storage.from(BUCKET).createSignedUrl(p.photoPath, SIGNED_URL_SECONDS);
        photoUrl = data?.signedUrl ?? null;
      }
      return { ...p, photoUrl };
    }),
  );

  return NextResponse.json({ placements: withPhotos });
}
