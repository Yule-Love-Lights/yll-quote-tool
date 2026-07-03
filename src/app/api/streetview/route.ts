import { NextRequest, NextResponse } from 'next/server';
import { fetchStreetView, isGoogleMapsConfigured, resolveStreetViewPano } from '@/lib/googleMaps';
import { bearingBetween, destinationPoint } from '@/lib/geo';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';
export const maxDuration = 30;

// How far (metres) to step the camera along the road per "move" click. Panos on
// a residential street sit ~8–15m apart; if the first step lands on the SAME
// pano (sparse coverage) we retry at double before declaring the edge.
const STEP_M = 15;

// #110 W5-016/W5-017: shared fetch + success-JSON + error handling for both the
// plain angle re-fetch and the "move along the street" step — was duplicated
// near-verbatim in POST() and moveAlongStreet(). Logs server-side and returns a
// generic error (mirrors analyze-address's treatment) instead of the raw
// upstream err.message, which could leak Google internals.
async function fetchStreetViewResponse(
  lat: number,
  lng: number,
  opts: { heading?: number; pitch?: number; fov?: number },
  extraBody?: Record<string, unknown>,
): Promise<NextResponse> {
  try {
    const img = await fetchStreetView(lat, lng, opts);
    return NextResponse.json({
      photoBase64: img.base64,
      photoMediaType: img.mediaType,
      heading: opts.heading,
      pitch: opts.pitch,
      fov: opts.fov,
      ...extraBody,
    });
  } catch (err) {
    console.error('[api/streetview] fetch failed', err);
    return NextResponse.json({ error: 'Street View fetch failed' }, { status: 500 });
  }
}

// Re-fetch Street View at a different heading/pitch/fov so the user can rotate
// around obstacles (trees, trucks, scaffolding) blocking the default view.
// Does NOT re-run Claude analysis — cheap image-only fetch.
export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  // Cheap but still billable — 60/min/IP lets a user spin through angles.
  const blocked = rateLimitResponse(req, { bucket: 'streetview', limit: 60, windowMs: 60_000 });
  if (blocked) return blocked;

  if (!isGoogleMapsConfigured()) {
    return NextResponse.json(
      { error: 'Google Maps not configured' },
      { status: 503 },
    );
  }
  let body: {
    lat?: number; lng?: number; heading?: number; pitch?: number; fov?: number;
    // #15 "move along the street" params
    direction?: 'left' | 'right';
    camLat?: number; camLng?: number; houseLat?: number; houseLng?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // #15 — move the camera one panorama along the road (perpendicular to the
  // camera→house look), snapping to the nearest Google pano and re-aiming at the
  // house. Image-only, like the angle re-fetch — no Claude re-analysis.
  if (body.direction === 'left' || body.direction === 'right') {
    return moveAlongStreet(body);
  }

  const { lat, lng, heading, pitch, fov } = body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 });
  }
  return fetchStreetViewResponse(lat, lng, { heading, pitch, fov });
}

// Step the camera one panorama along the road and re-aim at the house (#15). The
// road runs ≈ perpendicular to the camera→house look, so we step ±90° off that
// bearing, snap to the nearest Google pano (metadata), and shoot back at the
// house. `reachedEnd: true` when there's no distinct next pano that way.
async function moveAlongStreet(body: {
  direction?: 'left' | 'right';
  camLat?: number; camLng?: number; houseLat?: number; houseLng?: number;
  pitch?: number; fov?: number;
}): Promise<NextResponse> {
  const { camLat, camLng, houseLat, houseLng, pitch, fov } = body;
  if (
    typeof camLat !== 'number' || typeof camLng !== 'number' ||
    typeof houseLat !== 'number' || typeof houseLng !== 'number'
  ) {
    return NextResponse.json(
      { error: 'camLat, camLng, houseLat, houseLng are required to move' },
      { status: 400 },
    );
  }
  // Resolve the pano the camera is on now (camLat/camLng may be the house coords
  // on the first move) — its real coords are the step origin, its id the "did we
  // actually move" guard.
  const current = await resolveStreetViewPano(camLat, camLng);
  if (current.status !== 'OK' || current.lat == null || current.lng == null) {
    return NextResponse.json({ reachedEnd: true });
  }
  const look = bearingBetween(current.lat, current.lng, houseLat, houseLng);
  const roadBearing = (look + (body.direction === 'right' ? 90 : -90) + 360) % 360;
  // Step out, snapping to the nearest pano; retry at 2× if we didn't leave the
  // current pano (sparse coverage) before declaring the edge.
  let target: { lat: number; lng: number; panoId?: string } | null = null;
  for (const dist of [STEP_M, STEP_M * 2]) {
    const stepped = destinationPoint(current.lat, current.lng, roadBearing, dist);
    const snap = await resolveStreetViewPano(stepped.lat, stepped.lng);
    if (snap.status === 'OK' && snap.lat != null && snap.lng != null && snap.panoId !== current.panoId) {
      target = { lat: snap.lat, lng: snap.lng, panoId: snap.panoId };
      break;
    }
  }
  if (!target) {
    return NextResponse.json({ reachedEnd: true });
  }
  const heading = bearingBetween(target.lat, target.lng, houseLat, houseLng);
  return fetchStreetViewResponse(target.lat, target.lng, { heading, pitch, fov }, {
    camLat: target.lat,
    camLng: target.lng,
    panoId: target.panoId,
    reachedEnd: false,
  });
}
