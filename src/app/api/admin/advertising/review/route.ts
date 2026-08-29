import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  acceptPlacement,
  DuplicatePlacementError,
  listPlacements,
  rejectPlacement,
  unacceptPlacement,
  type AdvertisingPlacement,
} from '@/lib/advertising/placements';
import { listAdvertisingWorkers } from '@/lib/advertising/workers';
import { listAdvertisingCampaigns } from '@/lib/advertising/campaigns';
import { findDuplicateCandidates } from '@/lib/advertising/duplicates';

export const runtime = 'nodejs';

/**
 * Admin placement review (ops hub workstream B) — the door that moves money.
 *
 *   GET  /api/admin/advertising/review — the queue: pending + resubmitted
 *        placements, each with worker/campaign names, a signed proof-photo
 *        URL, and duplicate-candidate flags (review-time tooling, never an
 *        automatic block — Naldo's ruling; signs legitimately cluster).
 *   POST /api/admin/advertising/review — { action: 'accept'|'reject'|
 *        'bulk-accept', ... }. The reviewer identity is ALWAYS the admin
 *        session; nothing in the body can stamp someone else's name.
 *
 * requireAdmin only (Naldo/Jason): office operators do not see placement
 * status, and the perimeter keeps advertising sessions out of /api/admin
 * entirely (isAdvertisingPath does not cover it).
 */

const BUCKET = 'advertising-proof';
const SIGNED_URL_SECONDS = 60 * 60;
const BULK_MAX = 200;

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const [pending, resubmitted, workers, campaigns] = await Promise.all([
    listPlacements({ status: 'pending', limit: 500 }),
    listPlacements({ status: 'resubmitted', limit: 500 }),
    listAdvertisingWorkers({ includeInactive: true }),
    listAdvertisingCampaigns({ includeInactive: true }),
  ]);
  const queue = [...pending, ...resubmitted];

  // Duplicate flags compare against the campaign's recent placements (any
  // status — an accepted sign 30m away is exactly what admin wants to see).
  // Bounded to the newest 1000 per campaign; older history is beyond the
  // "same batch, same corner" window this tooling exists for.
  const campaignIds = [...new Set(queue.map((p) => p.campaignId))];
  const byCampaign = new Map<string, AdvertisingPlacement[]>();
  await Promise.all(
    campaignIds.map(async (id) => {
      byCampaign.set(id, await listPlacements({ campaignId: id, limit: 1000 }));
    }),
  );

  const workerName = new Map(workers.map((w) => [w.id, w.displayName]));
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const sb = getSupabaseServiceClient();

  const signedUrl = async (path: string | null): Promise<string | null> => {
    if (!sb || !path) return null;
    const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    return data?.signedUrl ?? null;
  };

  const rows = await Promise.all(
    queue.map(async (p) => {
      const duplicates = findDuplicateCandidates(p, byCampaign.get(p.campaignId) ?? []);
      return {
        ...p,
        workerName: workerName.get(p.workerId) ?? '(unknown worker)',
        campaignName: campaignName.get(p.campaignId) ?? '(unknown campaign)',
        photoUrl: await signedUrl(p.photoPath),
        duplicates: await Promise.all(
          duplicates.map(async (d) => ({
            id: d.placement.id,
            status: d.placement.status,
            workerName: workerName.get(d.placement.workerId) ?? '(unknown worker)',
            capturedAt: d.placement.capturedAt,
            reasons: d.reasons,
            photoUrl: await signedUrl(d.placement.photoPath),
          })),
        ),
      };
    }),
  );

  return NextResponse.json({ queue: rows });
}

function isStateRefusal(message: string): boolean {
  return /moved to '|is '|cannot be|only rejected/.test(message);
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const adminId = auth.operator.id;

  const body = (await req.json().catch(() => null)) as
    | { action?: unknown; placementId?: unknown; reason?: unknown; placementIds?: unknown }
    | null;
  const action = String(body?.action ?? '');

  try {
    if (action === 'accept') {
      const placementId = String(body?.placementId ?? '').trim();
      if (!placementId) return NextResponse.json({ error: 'placementId is required' }, { status: 400 });
      const placement = await acceptPlacement(placementId, adminId);
      return NextResponse.json({ placement });
    }

    if (action === 'reject') {
      const placementId = String(body?.placementId ?? '').trim();
      const reason = String(body?.reason ?? '').trim();
      if (!placementId) return NextResponse.json({ error: 'placementId is required' }, { status: 400 });
      if (!reason) {
        return NextResponse.json(
          { error: 'A rejection reason is required — the worker sees it.' },
          { status: 400 },
        );
      }
      const placement = await rejectPlacement(placementId, adminId, reason);
      return NextResponse.json({ placement });
    }

    if (action === 'unaccept') {
      // The undo lever for a wrong accept (bulk-upload mistakes most of
      // all). The stamped rate is cleared and the row lands rejected; the
      // reason is required because the worker sees it.
      const placementId = String(body?.placementId ?? '').trim();
      const reason = String(body?.reason ?? '').trim();
      if (!placementId) return NextResponse.json({ error: 'placementId is required' }, { status: 400 });
      if (!reason) {
        return NextResponse.json(
          { error: 'A reason is required. The worker sees it.' },
          { status: 400 },
        );
      }
      const { placement, changed } = await unacceptPlacement(placementId, adminId, reason);
      return NextResponse.json({ placement, changed });
    }

    if (action === 'bulk-accept') {
      const ids = body?.placementIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_MAX) {
        return NextResponse.json(
          { error: `Send 1 to ${BULK_MAX} placement ids.` },
          { status: 400 },
        );
      }
      // Sequential on purpose: each accept is its own CAS + audit row, and a
      // failure in one must not stop or poison the rest.
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const raw of ids) {
        const id = String(raw).trim();
        try {
          await acceptPlacement(id, adminId);
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, error: e instanceof Error ? e.message : 'failed' });
        }
      }
      return NextResponse.json({ results });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Review action failed';
    console.error('POST /api/admin/advertising/review:', message);
    if (e instanceof DuplicatePlacementError) {
      // Accepting a second copy of a photo already accepted for this
      // worker and campaign. A refusal the admin can act on, not a crash.
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (isStateRefusal(message)) {
      return NextResponse.json(
        { error: 'That placement was already reviewed. Reload the queue.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Review action failed. Try again.' }, { status: 500 });
  }
}
