import { NextRequest, NextResponse } from 'next/server';
import { fetchStreetView, isGoogleMapsConfigured } from '@/lib/googleMaps';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Re-fetch Street View at a different heading/pitch/fov so the user can rotate
// around obstacles (trees, trucks, scaffolding) blocking the default view.
// Does NOT re-run Claude analysis — cheap image-only fetch.
export async function POST(req: NextRequest) {
  if (!isGoogleMapsConfigured()) {
    return NextResponse.json(
      { error: 'Google Maps not configured' },
      { status: 503 },
    );
  }
  let body: { lat?: number; lng?: number; heading?: number; pitch?: number; fov?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { lat, lng, heading, pitch, fov } = body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 });
  }
  try {
    const img = await fetchStreetView(lat, lng, { heading, pitch, fov });
    return NextResponse.json({
      photoBase64: img.base64,
      photoMediaType: img.mediaType,
      heading,
      pitch,
      fov,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Street View fetch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
