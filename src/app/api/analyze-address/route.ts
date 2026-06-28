import { NextRequest, NextResponse } from 'next/server';
import { analyzePhoto, ANALYZER_UNAVAILABLE_MESSAGE } from '@/lib/photoAnalysis';
import { isClaudeConfigured } from '@/lib/claude';
import { assembleFewShot } from '@/lib/fewShot';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';
import {
  isGoogleMapsConfigured,
  geocodeAddress,
  fetchStreetView,
  fetchSatellite,
  hasStreetView,
} from '@/lib/googleMaps';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  // Each call hits Anthropic + 2 Google Maps APIs — cap at 20/min/IP to
  // protect budget if someone scripts it. Normal interactive use is 1/min.
  const blocked = rateLimitResponse(req, { bucket: 'analyze-address', limit: 20, windowMs: 60_000 });
  if (blocked) return blocked;

  if (!isClaudeConfigured()) {
    return NextResponse.json(
      { error: 'Photo analysis not configured — ANTHROPIC_API_KEY missing' },
      { status: 503 },
    );
  }
  if (!isGoogleMapsConfigured()) {
    return NextResponse.json(
      { error: 'Google Maps not configured — set GOOGLE_MAPS_API_KEY in .env.local' },
      { status: 503 },
    );
  }

  let body: { address?: string; houseStyle?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const address = body.address?.trim();
  if (!address) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 });
  }
  const houseStyleHint = body.houseStyle?.trim() || undefined;

  // ── 1. Fetch imagery (geocode + Street View + satellite) ──────────────────
  // A failure here is genuinely blocking (bad address / no imagery / Google
  // down) — return an error.
  let geo: Awaited<ReturnType<typeof geocodeAddress>>;
  let streetView: Awaited<ReturnType<typeof fetchStreetView>>;
  let satellite: Awaited<ReturnType<typeof fetchSatellite>>;
  let satelliteFeetPerPixel: number;
  try {
    geo = await geocodeAddress(address);

    // Confirm Street View exists at this location
    const svExists = await hasStreetView(geo.lat, geo.lng);
    if (!svExists) {
      return NextResponse.json(
        { error: `No Street View imagery available at ${geo.formattedAddress}` },
        { status: 404 },
      );
    }

    // Fetch both images in parallel
    [streetView, satellite] = await Promise.all([
      fetchStreetView(geo.lat, geo.lng),
      fetchSatellite(geo.lat, geo.lng),
    ]);

    // Compute feet-per-pixel for the satellite image. Google Static Maps
    // at zoom=20 uses: meters_per_pixel = 156543.03392 * cos(lat) / 2^zoom.
    // Converted to feet (× 3.28084). This is deterministic — no calibration needed.
    const SAT_ZOOM = 20;
    const metersPerPixel =
      (156543.03392 * Math.cos((geo.lat * Math.PI) / 180)) /
      Math.pow(2, SAT_ZOOM);
    satelliteFeetPerPixel = metersPerPixel * 3.28084;
  } catch (err) {
    // Audit fix (#100): log the upstream detail server-side only. Returning
    // raw err.message to the client could leak Google internals (e.g.
    // OVER_QUERY_LIMIT / REQUEST_DENIED with key context), so respond with a
    // generic message instead.
    console.error('analyze-address imagery fetch failed:', err);
    return NextResponse.json(
      { error: 'Failed to fetch imagery for this address' },
      { status: 502 },
    );
  }

  // ── 2. Analyze with Claude (#8 few-shot) — FAIL-SAFE ──────────────────────
  // If the analyzer is unavailable (e.g. Claude is down/overloaded) we still
  // return the imagery with result: null so the client can load the photos and
  // staff design the house MANUALLY. A Claude outage must not block the quote.
  // Unified few-shot: similarity-ranked by the street photo when Voyage +
  // embeddings are available, else recency; the satellite rides along to
  // analyzePhoto for satellite-coordinate measurement (separate from ranking).
  let result: Awaited<ReturnType<typeof analyzePhoto>> | null = null;
  let analysisError: string | undefined;
  let fewShotCount = 0;
  let fewShotBreakdown: { ranking?: 'similarity' | 'recency' } | undefined;
  try {
    const { examples, references, biasNote, breakdown } = await assembleFewShot(
      houseStyleHint,
      { base64: streetView.base64, mediaType: streetView.mediaType },
    );
    result = await analyzePhoto(
      streetView.base64,
      streetView.mediaType,
      examples,
      {
        satellite: {
          base64: satellite.base64,
          mediaType: satellite.mediaType,
          feetPerPixel: satelliteFeetPerPixel,
        },
        references,
        houseStyleHint,
        corpusBiasNote: biasNote,
      },
    );
    fewShotCount = examples.length;
    fewShotBreakdown = breakdown;
  } catch (err) {
    console.error('analyze-address: AI analysis failed — returning imagery for manual design:', err);
    analysisError = ANALYZER_UNAVAILABLE_MESSAGE;
  }

  return NextResponse.json({
    result,
    analysisUnavailable: result === null,
    analysisError,
    photoBase64: streetView.base64,
    photoMediaType: streetView.mediaType,
    satelliteBase64: satellite.base64,
    satelliteMediaType: satellite.mediaType,
    satelliteFeetPerPixel,
    formattedAddress: geo.formattedAddress,
    lat: geo.lat,
    lng: geo.lng,
    fewShotCount,
    fewShotBreakdown,
  });
}
