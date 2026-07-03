import { NextRequest, NextResponse } from 'next/server';
import { isClaudeConfigured } from '@/lib/claude';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { runAnalyzeWithFewShot } from '@/lib/analyzeWithFewShot';
import {
  isGoogleMapsConfigured,
  getCachedAddressImagery,
  NoStreetViewError,
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
  // #110 W5-013 (cost): cached by normalized address so a repeat request for
  // the same address (common during staff testing / a post-outage retry)
  // doesn't re-bill geocode + Street View + satellite.
  let geo: { lat: number; lng: number; formattedAddress: string };
  let streetView: { base64: string; mediaType: 'image/jpeg' | 'image/png' };
  let satellite: { base64: string; mediaType: 'image/jpeg' | 'image/png' };
  let satelliteFeetPerPixel: number;
  try {
    ({ geo, streetView, satellite, satelliteFeetPerPixel } = await getCachedAddressImagery(address));
  } catch (err) {
    if (err instanceof NoStreetViewError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    // Audit fix (#100): log the upstream detail server-side only. Returning
    // raw err.message to the client could leak Google internals (e.g.
    // OVER_QUERY_LIMIT / REQUEST_DENIED with key context), so respond with a
    // generic message instead.
    // #110 W5-015: bracketed '[api/route/context]' prefix, matching the charter.
    console.error('[api/analyze-address] imagery fetch failed:', err);
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
  // #110 W5-014: shared with analyze-photo/route.ts via runAnalyzeWithFewShot.
  const { result, analysisUnavailable, analysisError, fewShotCount, fewShotBreakdown } =
    await runAnalyzeWithFewShot(
      streetView.base64,
      streetView.mediaType,
      houseStyleHint,
      {
        satellite: {
          base64: satellite.base64,
          mediaType: satellite.mediaType,
          feetPerPixel: satelliteFeetPerPixel,
        },
      },
      '[api/analyze-address]',
    );

  return NextResponse.json({
    result,
    analysisUnavailable,
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
