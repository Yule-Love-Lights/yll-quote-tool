import { NextRequest, NextResponse } from 'next/server';
import { isClaudeConfigured } from '@/lib/claude';
import { rateLimitResponse } from '@/lib/rateLimit';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { runAnalyzeWithFewShot } from '@/lib/analyzeWithFewShot';
import {
  analyzePermanentSatellite,
  type PermanentSatelliteAnalysis,
  type PermanentFewShotMessage,
} from '@/lib/permanent/photoAnalysis';
import { assemblePermanentFewShot, buildPermanentFewShotMessages } from '@/lib/permanent/fewShot';
import { bearingDegrees } from '@/lib/permanent/orientation';
import {
  isGoogleMapsConfigured,
  getCachedAddressImagery,
  getAddressSatelliteImagery,
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

  let body: { address?: string; houseStyle?: string; serviceType?: string };
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
  let panoLocation: { lat: number; lng: number } | null;
  try {
    ({ geo, streetView, satellite, satelliteFeetPerPixel, panoLocation } = await getCachedAddressImagery(address));
  } catch (err) {
    if (err instanceof NoStreetViewError) {
      // #204: PARTIAL SUCCESS — the satellite leg doesn't need Street View at
      // all, so a missing pano no longer kills the whole request. Fetch just
      // the satellite image + its real scale and tell the client honestly.
      // No analyzer runs here (every analyzer needs a street photo to look
      // at, and we don't have one) — the operator uploads their own photo and
      // analyzes that separately; the #190 guard keeps this satellite/scale
      // intact through that later analyze (hasSatellitePayload).
      try {
        const sat = await getAddressSatelliteImagery(address);
        return NextResponse.json({
          result: null,
          streetViewUnavailable: true,
          satelliteBase64: sat.satellite.base64,
          satelliteMediaType: sat.satellite.mediaType,
          satelliteFeetPerPixel: sat.satelliteFeetPerPixel,
          formattedAddress: sat.geo.formattedAddress,
          lat: sat.geo.lat,
          lng: sat.geo.lng,
        });
      } catch (satErr) {
        console.error('[api/analyze-address] satellite-only fallback failed:', satErr);
        return NextResponse.json(
          { error: 'Failed to fetch imagery for this address' },
          { status: 502 },
        );
      }
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

  // ── #88/#140: permanent lighting uses its OWN analyzer (not the holiday
  // roofline one — that hunts ridges + a santas/gingerbread split that don't
  // apply to puck-on-track). The permanent analyzer traces the FOUR side
  // channels on the satellite; the client seeds them into the same editable
  // permanentSatLines the operator draws by hand, and footage/corners/
  // extension-counts all derive from those lines. FAIL-SAFE: an analyzer
  // outage still returns the imagery so the operator draws manually.
  if (body.serviceType === 'permanent') {
    let permanentSatellite: PermanentSatelliteAnalysis | null = null;
    let permanentAnalysisError: string | undefined;
    // S25: the Street View camera sits on the road → house→camera bearing =
    // the direction the front faces. Deterministic orientation for the side
    // labels (the AI's own road-guess flipped a real house 180°).
    const frontBearingDeg = panoLocation ? bearingDegrees(geo, panoLocation) : null;
    // #141: the permanent training loop's few-shot — operator-confirmed past
    // houses, satellite-similarity ranked. FAIL-SAFE: any assembly error
    // (embed/retrieval/projection) proceeds zero-shot rather than blocking
    // the analyzer.
    let fewShotMessages: PermanentFewShotMessage[] = [];
    let fewShotCount = 0;
    try {
      const assembled = await assemblePermanentFewShot(satellite.base64, satellite.mediaType);
      fewShotMessages = await buildPermanentFewShotMessages(assembled.examples);
      fewShotCount = assembled.examples.length;
    } catch (err) {
      console.error('[api/analyze-address] permanent few-shot assembly failed — proceeding zero-shot:', err);
    }
    try {
      permanentSatellite = await analyzePermanentSatellite({
        satelliteBase64: satellite.base64,
        satelliteMediaType: satellite.mediaType,
        streetBase64: streetView.base64,
        streetMediaType: streetView.mediaType,
        feetPerPixel: satelliteFeetPerPixel,
        frontBearingDeg,
        fewShotMessages,
      });
    } catch (err) {
      console.error('[api/analyze-address] permanent satellite analyzer failed:', err);
      permanentAnalysisError =
        'The satellite auto-trace is temporarily unavailable — photos are loaded; draw the side rooflines manually or retry in a few minutes.';
    }
    return NextResponse.json({
      result: null,
      permanentImageryOnly: true,
      permanentSatellite,
      ...(permanentAnalysisError ? { permanentAnalysisError } : {}),
      photoBase64: streetView.base64,
      photoMediaType: streetView.mediaType,
      satelliteBase64: satellite.base64,
      satelliteMediaType: satellite.mediaType,
      satelliteFeetPerPixel,
      formattedAddress: geo.formattedAddress,
      lat: geo.lat,
      lng: geo.lng,
      fewShotCount,
    });
  }

  // ── #117: permanent bistro is DESIGN-DRAWN ONLY — no manual footage entry
  // and no auto-analyzer (the client discards any analyzer result for this
  // vertical; see QuoteBuilder's handleLookupAddress). Running the full
  // holiday analyzer here would burn an Anthropic call for a result nobody
  // reads, so return the same imagery payload with no analysis result.
  if (body.serviceType === 'permanent_bistro') {
    return NextResponse.json({
      result: null,
      photoBase64: streetView.base64,
      photoMediaType: streetView.mediaType,
      satelliteBase64: satellite.base64,
      satelliteMediaType: satellite.mediaType,
      satelliteFeetPerPixel,
      formattedAddress: geo.formattedAddress,
      lat: geo.lat,
      lng: geo.lng,
    });
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
