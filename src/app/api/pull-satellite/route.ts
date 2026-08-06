import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isGoogleMapsConfigured, getAddressSatelliteImagery } from '@/lib/googleMaps';

export const runtime = 'nodejs';
export const maxDuration = 30;

// #204: "Pull satellite" — the operator's address-only escape hatch for a
// house Street View can't serve (analyze-address's full lookup has
// historically 404'd the WHOLE request on those). Geocodes the typed address
// and fetches ONLY the satellite image + its real feet-per-pixel scale — NO
// Claude call, NO line-seeding (locked: instant; the operator draws channels
// by hand and footage derives from the drawn geometry, same as any other
// satellite trace). Reuses the SAME primitives + scale math as analyze-address
// (getAddressSatelliteImagery in googleMaps.ts) rather than forking them.
//
// Operator-only builder feature: NOT in operatorGate's public allowlist by
// design (mirrors /api/analyze-address and /api/streetview) — requireOperator
// below is the gate.
export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  // Cheap (geocode + one Static Maps tile, no Anthropic call) but still a
  // paid Google API hit — same guardrail shape as the other address routes.
  const blocked = rateLimitResponse(req, { bucket: 'pull-satellite', limit: 20, windowMs: 60_000 });
  if (blocked) return blocked;

  if (!isGoogleMapsConfigured()) {
    return NextResponse.json(
      { error: 'Google Maps not configured — set GOOGLE_MAPS_API_KEY in .env.local' },
      { status: 503 },
    );
  }

  let body: { address?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const address = body.address?.trim();
  if (!address) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 });
  }

  try {
    const { geo, satellite, satelliteFeetPerPixel, streetViewAvailable } =
      await getAddressSatelliteImagery(address);
    return NextResponse.json({
      satelliteBase64: satellite.base64,
      satelliteMediaType: satellite.mediaType,
      satelliteFeetPerPixel,
      formattedAddress: geo.formattedAddress,
      lat: geo.lat,
      lng: geo.lng,
      streetViewAvailable,
    });
  } catch (err) {
    // Same non-leaking pattern as analyze-address/streetview: log the upstream
    // detail server-side only (can carry Google key/quota context), respond
    // with a generic message.
    console.error('[api/pull-satellite] imagery fetch failed:', err);
    return NextResponse.json(
      { error: 'Failed to fetch satellite imagery for this address' },
      { status: 502 },
    );
  }
}
