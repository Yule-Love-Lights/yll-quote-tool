import { NextResponse, type NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { listPlacements, type AdvertisingPlacement } from '@/lib/advertising/placements';
import { listAdvertisingWorkers } from '@/lib/advertising/workers';
import { findDuplicateCandidates } from '@/lib/advertising/duplicates';

export const runtime = 'nodejs';

const BUCKET = 'advertising-proof';
const SIGNED_URL_SECONDS = 60 * 60;

/**
 * GET /api/admin/advertising/campaigns/[id]/placements — one campaign's
 * FULL photo feed for the admin detail screen (Simple Crew replica): every
 * status, newest first, with worker names, signed photo URLs, worker notes,
 * and duplicate flags. Bounded to the newest 1000 (the review window this
 * tooling exists for); the count in the header comes from the campaigns
 * summary, so truncation is visible rather than silent.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const { id } = await ctx.params;
  const [placements, workers] = await Promise.all([
    listPlacements({ campaignId: id, limit: 1000 }),
    listAdvertisingWorkers({ includeInactive: true }),
  ]);
  const workerName = new Map(workers.map((w) => [w.id, w.displayName]));
  const sb = getSupabaseServiceClient();

  const signedUrl = async (path: string | null): Promise<string | null> => {
    if (!sb || !path) return null;
    const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    return data?.signedUrl ?? null;
  };

  const rows = await Promise.all(
    placements.map(async (p: AdvertisingPlacement) => ({
      ...p,
      workerName: workerName.get(p.workerId) ?? '(unknown worker)',
      photoUrl: await signedUrl(p.photoPath),
      duplicates: findDuplicateCandidates(p, placements).map((d) => ({
        id: d.placement.id,
        status: d.placement.status,
        workerName: workerName.get(d.placement.workerId) ?? '(unknown worker)',
        reasons: d.reasons,
      })),
    })),
  );

  return NextResponse.json({ placements: rows });
}
