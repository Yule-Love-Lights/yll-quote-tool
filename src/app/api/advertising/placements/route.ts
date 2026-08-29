import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { getAdvertisingCampaign } from '@/lib/advertising/campaigns';
import { listPlacements, submitPlacement, type PlacementStatus } from '@/lib/advertising/placements';
import { reverseGeocode } from '@/lib/advertising/geocode';

export const runtime = 'nodejs';

/**
 * Worker capture + own-placements API (ops hub workstream B).
 *
 *   POST /api/advertising/placements — submit one placement: multipart with a
 *        proof photo + campaign/kind/GPS fields. The worker identity is FORCED
 *        from the session; nothing in the body can submit as someone else.
 *   GET  /api/advertising/placements — the caller's own placements, newest
 *        first, optional ?status= filter, each with a short-lived signed URL
 *        for its own proof photo.
 *
 * The perimeter (isAdvertisingPath) confines advertising sessions TO this
 * namespace; getAdvertisingCaller confines this namespace to advertising
 * sessions (operators/admins are 403'd — office does not see placement
 * status; admin review has its own door under /api/admin/advertising).
 */

const PHOTO_MAX_BYTES = 12 * 1024 * 1024;
const SIGNED_URL_SECONDS = 60 * 60;
const BUCKET = 'advertising-proof';

/** Magic-byte sniff, same posture as the site-forms resume check: the gap
 * between what the uploader CLAIMS the file is and what it actually is. */
function sniffImage(head: Uint8Array): { ext: string; contentType: string } | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}

export async function POST(req: NextRequest) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Send the capture as multipart form data.' }, { status: 400 });
  }

  const campaignId = String(form.get('campaignId') ?? '').trim();
  const kind = String(form.get('kind') ?? '').trim();
  const lat = Number(form.get('lat'));
  const lng = Number(form.get('lng'));
  const accuracyRaw = form.get('accuracyM');
  const accuracyM = accuracyRaw === null || accuracyRaw === '' ? null : Number(accuracyRaw);
  const capturedAtRaw = String(form.get('capturedAt') ?? '').trim();
  const routeText = String(form.get('route') ?? '').trim();
  const neighborhood = String(form.get('neighborhood') ?? '').trim();

  if (kind !== 'yard_sign' && kind !== 'door_hanger') {
    return NextResponse.json({ error: 'Pick yard sign or door hanger.' }, { status: 400 });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json(
      { error: 'No GPS fix. Allow location access and try again.' },
      { status: 400 },
    );
  }
  if (accuracyM !== null && (!Number.isFinite(accuracyM) || accuracyM < 0)) {
    return NextResponse.json({ error: 'Bad GPS accuracy value.' }, { status: 400 });
  }
  if (!campaignId) {
    return NextResponse.json({ error: 'Pick a campaign.' }, { status: 400 });
  }
  const campaign = await getAdvertisingCampaign(campaignId);
  if (!campaign || !campaign.active) {
    return NextResponse.json({ error: 'That campaign is not open for submissions.' }, { status: 400 });
  }

  const photo = form.get('photo');
  if (!(photo instanceof File) || photo.size === 0) {
    return NextResponse.json({ error: 'A proof photo is required.' }, { status: 400 });
  }
  if (photo.size > PHOTO_MAX_BYTES) {
    return NextResponse.json(
      { error: 'That photo is too large (12MB max). Use your camera\'s smaller size and retake it.' },
      { status: 400 },
    );
  }
  const bytes = Buffer.from(await photo.arrayBuffer());
  const sniffed = sniffImage(new Uint8Array(bytes.subarray(0, 12)));
  if (!sniffed) {
    return NextResponse.json({ error: 'The proof must be a JPEG, PNG or WebP photo.' }, { status: 400 });
  }

  // Upload FIRST: a pay claim with no proof photo must never exist (the
  // accepted-shape CHECK enforces the same at review time).
  const photoPath = `placements/${caller.worker.id}/${randomUUID()}.${sniffed.ext}`;
  const { error: uploadError } = await sb.storage.from(BUCKET).upload(photoPath, bytes, {
    contentType: sniffed.contentType,
    upsert: false,
  });
  if (uploadError) {
    console.error('POST /api/advertising/placements upload:', uploadError.message);
    return NextResponse.json(
      { error: 'The photo could not be saved. Nothing was submitted — try again.' },
      { status: 502 },
    );
  }

  // Best-effort convenience; the GPS point is the record.
  const suggestedAddress = await reverseGeocode(lat, lng);

  try {
    const placement = await submitPlacement({
      campaignId,
      workerId: caller.worker.id, // ALWAYS the session's worker
      kind,
      lat,
      lng,
      accuracyM,
      capturedAt: capturedAtRaw || null,
      photoPath,
      suggestedAddress,
      route: routeText || null,
      neighborhood: neighborhood || null,
      isTest: caller.worker.isTest,
    });
    return NextResponse.json({ placement }, { status: 201 });
  } catch (e) {
    console.error('POST /api/advertising/placements:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'The placement could not be saved. Try again.' }, { status: 500 });
  }
}

const LISTABLE_STATUSES: ReadonlySet<string> = new Set(['pending', 'accepted', 'rejected', 'resubmitted']);

export async function GET(req: NextRequest) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const statusParam = req.nextUrl.searchParams.get('status') ?? '';
  const status = LISTABLE_STATUSES.has(statusParam) ? (statusParam as PlacementStatus) : undefined;

  // Scoped to the SESSION worker — a workerId query param is ignored.
  const placements = await listPlacements({ workerId: caller.worker.id, status });

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
