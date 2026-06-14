import { NextRequest, NextResponse } from 'next/server';
import { analyzePhoto, correctionToExample, FewShotExample } from '@/lib/photoAnalysis';
import { isClaudeConfigured } from '@/lib/claude';
import { getRecentCorrections } from '@/lib/corrections';
import { getRecentTrainingExamples, exampleToFewShot } from '@/lib/trainingExamples';
import { getTrainingFewShot } from '@/lib/training';
import { getReferenceAssetsForAnalysis } from '@/lib/referenceAssets';
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

    // 4. Analyze with Claude using BOTH images as cross-reference
    const [sceneExamples, corrections, trainingHouses, references] = await Promise.all([
      getRecentTrainingExamples(2),
      getRecentCorrections(2),
      getTrainingFewShot(2, houseStyleHint),
      getReferenceAssetsForAnalysis(2),
    ]);
    // Scene-based examples (#8 Stage A) take the correction slots first;
    // legacy photo_corrections only fill what's left (they sunset at the
    // planned data wipe).
    const designFewShots = sceneExamples
      .map(exampleToFewShot)
      .filter((e): e is NonNullable<typeof e> => e != null);
    const correctionFill = corrections
      .slice(0, Math.max(0, 2 - designFewShots.length))
      .map(correctionToExample);
    const examples: FewShotExample[] = [
      ...trainingHouses
        .filter(h => h.photos?.length && h.santas_footage != null && h.gingerbread_footage != null)
        .map(h => {
          const ordered = [...h.photos].sort((a, b) => {
            const order: Record<string, number> = {
              front_install: 0, front_takedown: 1, side: 2, detail: 3, back: 4, satellite: 5, other: 6,
            };
            return (order[a.tag] ?? 9) - (order[b.tag] ?? 9);
          }).slice(0, 4);
          return {
            photos: ordered.map(p => ({
              base64: p.base64,
              mediaType: p.mediaType,
              tag: p.tag,
              caption: p.caption,
            })),
            santasFootage: h.santas_footage!,
            santasDifficulty: h.santas_difficulty ?? 'medium',
            santasLines: h.santas_lines ?? [],
            gingerbreadFootage: h.gingerbread_footage!,
            gingerbreadDifficulty: h.gingerbread_difficulty ?? 'medium',
            gingerbreadLines: h.gingerbread_lines ?? [],
            miniLightDetections: h.mini_light_detections ?? [],
            wreathDetections: h.wreath_detections ?? [],
            spritzerDetections: h.spritzer_detections ?? [],
            garlandDetections: h.garland_detections ?? [],
            houseStyle: h.house_style ?? undefined,
            aiFailureNotes: h.ai_failure_notes,
            source: 'training' as const,
          };
        }),
      ...designFewShots,
      ...correctionFill,
    ];
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
      fewShotBreakdown: {
        training: trainingHouses.length,
        examples: designFewShots.length,
        corrections: correctionFill.length,
        references: references.length,
      },
    });
  } catch (err) {
    console.error('analyze-address error:', err);
    const message = err instanceof Error ? err.message : 'Failed to analyze address';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
