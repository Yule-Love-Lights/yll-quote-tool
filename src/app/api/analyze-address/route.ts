import { NextRequest, NextResponse } from 'next/server';
import { analyzePhoto } from '@/lib/photoAnalysis';
import { isClaudeConfigured } from '@/lib/claude';
import { assembleFewShot } from '@/lib/fewShot';
import { rateLimitResponse } from '@/lib/rateLimit';
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

  try {
    // 1. Geocode the address
    const geo = await geocodeAddress(address);

    // 2. Confirm Street View exists at this location
    const svExists = await hasStreetView(geo.lat, geo.lng);
    if (!svExists) {
      return NextResponse.json(
        { error: `No Street View imagery available at ${geo.formattedAddress}` },
        { status: 404 },
      );
    }

    // 3. Fetch both images in parallel
    const [streetView, satellite] = await Promise.all([
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
    const satelliteFeetPerPixel = metersPerPixel * 3.28084;

    // 4. Analyze with Claude using BOTH images as cross-reference. Unified
    // few-shot (#8 Stage B): similarity-ranked by the street photo when Voyage
    // + embeddings are available, else recency. The satellite rides along to
    // analyzePhoto for the satellite-coordinate measurement, separate from
    // few-shot ranking (which keys on the street view).
    const { examples, references, breakdown } = await assembleFewShot(
      houseStyleHint,
      { base64: streetView.base64, mediaType: streetView.mediaType },
    );
    const result = await analyzePhoto(
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
      },
    );

    return NextResponse.json({
      result,
      photoBase64: streetView.base64,
      photoMediaType: streetView.mediaType,
      satelliteBase64: satellite.base64,
      satelliteMediaType: satellite.mediaType,
      satelliteFeetPerPixel,
      formattedAddress: geo.formattedAddress,
      lat: geo.lat,
      lng: geo.lng,
      fewShotCount: examples.length,
      fewShotBreakdown: breakdown,
    });
  } catch (err) {
    console.error('analyze-address error:', err);
    const message = err instanceof Error ? err.message : 'Failed to analyze address';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
