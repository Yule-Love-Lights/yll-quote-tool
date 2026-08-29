import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { getSupabaseServiceClient } from '@/lib/supabase';
import { getAdvertisingCampaign } from '@/lib/advertising/campaigns';
import { submitPlacement } from '@/lib/advertising/placements';
import { reverseGeocode } from '@/lib/advertising/geocode';
import { computePhotoHash } from '@/lib/advertising/photoHashCompute';
import { MULTIPART_SIZE_LIMIT_BYTES } from '@/lib/clientImage';
import type { AdvertisingWorker } from '@/lib/advertising/workers';

// The ONE capture pipeline (Simple Crew replica): multipart photo + GPS ->
// magic-byte sniff -> size cap -> upload proof FIRST -> reverse geocode ->
// pending placement. Shared by the worker route (session worker) and the
// admin route (auto-provisioned worker row), so the two can never drift on
// validation or the upload-before-row ordering.

const PHOTO_MAX_BYTES = MULTIPART_SIZE_LIMIT_BYTES;
const BUCKET = 'advertising-proof';

/** Magic-byte sniff, same posture as the site-forms resume check. */
export function sniffImage(head: Uint8Array): { ext: string; contentType: string } | null {
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

export async function handleCaptureSubmit(req: NextRequest, worker: AdvertisingWorker): Promise<NextResponse> {
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
  const lat = Number(form.get('lat'));
  const lng = Number(form.get('lng'));
  const accuracyRaw = form.get('accuracyM');
  const accuracyM = accuracyRaw === null || accuracyRaw === '' ? null : Number(accuracyRaw);
  const capturedAtRaw = String(form.get('capturedAt') ?? '').trim();
  const routeText = String(form.get('route') ?? '').trim();
  const neighborhood = String(form.get('neighborhood') ?? '').trim();
  const workerNote = String(form.get('note') ?? '').trim();

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
  // The KIND comes from the CAMPAIGN, never the body — same treatment as
  // workerId (technical lens HIGH, PR #1078). Since 2026-08-29 every kind
  // pays the campaign rate, so kind no longer gates money; it still labels
  // the record and drives sign-stock counts, and a client must not be able
  // to relabel a campaign's work.
  const kind = campaign.kind;

  const photo = form.get('photo');
  if (!(photo instanceof File) || photo.size === 0) {
    return NextResponse.json({ error: 'A proof photo is required.' }, { status: 400 });
  }
  if (photo.size > PHOTO_MAX_BYTES) {
    return NextResponse.json(
      { error: 'That photo is too large (4MB max). Retake it with your camera set to a smaller size.' },
      { status: 400 },
    );
  }
  const bytes = Buffer.from(await photo.arrayBuffer());
  const sniffed = sniffImage(new Uint8Array(bytes.subarray(0, 12)));
  if (!sniffed) {
    return NextResponse.json({ error: 'The proof must be a JPEG, PNG or WebP photo.' }, { status: 400 });
  }

  // Upload FIRST: a pay claim with no proof photo must never exist.
  const photoPath = `placements/${worker.id}/${randomUUID()}.${sniffed.ext}`;
  const { error: uploadError } = await sb.storage.from(BUCKET).upload(photoPath, bytes, {
    contentType: sniffed.contentType,
    upsert: false,
  });
  if (uploadError) {
    console.error('capture submit upload:', uploadError.message);
    return NextResponse.json(
      { error: 'The photo could not be saved. Nothing was submitted — try again.' },
      { status: 502 },
    );
  }

  const suggestedAddress = await reverseGeocode(lat, lng);
  // Perceptual hash for the review queue's "very similar photo" flag.
  // Best-effort: null on any failure, the capture never fails over it.
  const photoHash = await computePhotoHash(bytes);

  try {
    const placement = await submitPlacement({
      campaignId,
      workerId: worker.id, // ALWAYS the resolved worker, never the body
      kind,
      lat,
      lng,
      accuracyM,
      capturedAt: capturedAtRaw || null,
      photoPath,
      suggestedAddress,
      route: routeText || null,
      neighborhood: neighborhood || null,
      workerNote: workerNote || null,
      photoHash,
      isTest: worker.isTest,
    });
    return NextResponse.json({ placement }, { status: 201 });
  } catch (e) {
    console.error('capture submit:', e instanceof Error ? e.message : e);
    try {
      await sb.storage.from(BUCKET).remove([photoPath]);
    } catch (cleanupError) {
      console.error('capture submit orphan cleanup:', cleanupError);
    }
    return NextResponse.json({ error: 'The placement could not be saved. Try again.' }, { status: 500 });
  }
}
