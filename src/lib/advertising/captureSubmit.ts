import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { getSupabaseServiceClient } from '@/lib/supabase';
import { getAdvertisingCampaign } from '@/lib/advertising/campaigns';
import { findAcceptedByPhotoHash, submitAcceptedPlacement, submitPlacement } from '@/lib/advertising/placements';
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

type SupabaseServiceClient = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

type ProofIntake =
  | { ok: true; photoPath: string; photoHash: string | null }
  | { ok: false; res: NextResponse };

/** The shared photo intake: presence, size cap, magic-byte sniff, then
 * upload FIRST (a pay claim with no proof photo must never exist), then the
 * best-effort perceptual hash. Used by the live capture AND the admin bulk
 * upload so the two can never drift on what counts as a valid proof. */
async function intakeProofPhoto(
  sb: SupabaseServiceClient,
  form: FormData,
  workerId: string,
): Promise<ProofIntake> {
  const photo = form.get('photo');
  if (!(photo instanceof File) || photo.size === 0) {
    return { ok: false, res: NextResponse.json({ error: 'A proof photo is required.' }, { status: 400 }) };
  }
  if (photo.size > PHOTO_MAX_BYTES) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'That photo is too large (4MB max). Retake it with your camera set to a smaller size.' },
        { status: 400 },
      ),
    };
  }
  const bytes = Buffer.from(await photo.arrayBuffer());
  const sniffed = sniffImage(new Uint8Array(bytes.subarray(0, 12)));
  if (!sniffed) {
    return {
      ok: false,
      res: NextResponse.json({ error: 'The proof must be a JPEG, PNG or WebP photo.' }, { status: 400 }),
    };
  }

  const photoPath = `placements/${workerId}/${randomUUID()}.${sniffed.ext}`;
  const { error: uploadError } = await sb.storage.from(BUCKET).upload(photoPath, bytes, {
    contentType: sniffed.contentType,
    upsert: false,
  });
  if (uploadError) {
    console.error('capture submit upload:', uploadError.message);
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'The photo could not be saved. Nothing was submitted. Try again.' },
        { status: 502 },
      ),
    };
  }

  // Perceptual hash for the review queue's "very similar photo" flag.
  // Best-effort: null on any failure, the capture never fails over it.
  const photoHash = await computePhotoHash(bytes);
  return { ok: true, photoPath, photoHash };
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

  const intake = await intakeProofPhoto(sb, form, worker.id);
  if (!intake.ok) return intake.res;
  const { photoPath, photoHash } = intake;

  const suggestedAddress = await reverseGeocode(lat, lng);

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

/**
 * Admin bulk upload (Naldo, 2026-08-29): backfill photos for work done
 * before the tool existed. Each call is ONE photo, attributed to the given
 * worker and landing directly ACCEPTED at the campaign's current rate,
 * reviewed by the uploading admin. GPS is optional here because camera-roll
 * files often carry none; when present it must be a complete, in-range
 * pair. The kind still comes from the CAMPAIGN, never the client.
 */
export async function handleBulkAcceptedSubmit(
  form: FormData,
  worker: AdvertisingWorker,
  adminUserId: string,
): Promise<NextResponse> {
  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
  }

  const campaignId = String(form.get('campaignId') ?? '').trim();
  if (!campaignId) {
    return NextResponse.json({ error: 'Pick a campaign.' }, { status: 400 });
  }
  const campaign = await getAdvertisingCampaign(campaignId);
  if (!campaign || !campaign.active) {
    return NextResponse.json({ error: 'That campaign is not open for submissions.' }, { status: 400 });
  }
  const kind = campaign.kind;

  // GPS: absent is fine (no pin, no location duplicate-flags), but a
  // one-sided or junk pair is refused rather than silently dropped, so a
  // photo never quietly loses a location the admin thought it had.
  const latRaw = String(form.get('lat') ?? '').trim();
  const lngRaw = String(form.get('lng') ?? '').trim();
  let lat: number | null = null;
  let lng: number | null = null;
  if (latRaw !== '' || lngRaw !== '') {
    lat = Number(latRaw);
    lng = Number(lngRaw);
    if (
      latRaw === '' || lngRaw === '' ||
      !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180
    ) {
      return NextResponse.json(
        { error: 'That photo carried a broken location. Remove it from the batch or retry without it.' },
        { status: 400 },
      );
    }
  }
  const capturedAtRaw = String(form.get('capturedAt') ?? '').trim();

  const intake = await intakeProofPhoto(sb, form, worker.id);
  if (!intake.ok) return intake.res;
  const { photoPath, photoHash } = intake;

  // Dedupe (technical lens HIGH, PR #1093): re-picking a whole folder after
  // a partial failure is the natural retry gesture, and without this every
  // already-accepted photo would mint a SECOND paid row. Exact hash match
  // for this worker+campaign is skipped as a duplicate; the just-uploaded
  // copy is removed so storage holds one proof per pay row.
  if (photoHash) {
    const existing = await findAcceptedByPhotoHash(worker.id, campaignId, photoHash);
    if (existing) {
      try {
        await sb.storage.from(BUCKET).remove([photoPath]);
      } catch (cleanupError) {
        console.error('bulk upload duplicate cleanup:', cleanupError);
      }
      return NextResponse.json({ duplicate: true, placement: existing }, { status: 200 });
    }
  }

  const suggestedAddress = lat !== null && lng !== null ? await reverseGeocode(lat, lng) : null;

  try {
    const placement = await submitAcceptedPlacement({
      campaignId,
      workerId: worker.id,
      kind,
      rateCents: campaign.rateCents,
      reviewedBy: adminUserId,
      lat,
      lng,
      capturedAt: capturedAtRaw || null,
      photoPath,
      suggestedAddress,
      photoHash,
      isTest: worker.isTest,
    });
    return NextResponse.json({ placement }, { status: 201 });
  } catch (e) {
    console.error('bulk upload submit:', e instanceof Error ? e.message : e);
    try {
      await sb.storage.from(BUCKET).remove([photoPath]);
    } catch (cleanupError) {
      console.error('bulk upload orphan cleanup:', cleanupError);
    }
    return NextResponse.json({ error: 'The placement could not be saved. Try again.' }, { status: 500 });
  }
}
