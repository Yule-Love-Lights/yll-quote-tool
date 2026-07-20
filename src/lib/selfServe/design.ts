// Persist the self-serve estimate's MEASUREMENT, not just its numbers.
//
// The first version of /api/estimate took the analyzer's footage numbers and
// discarded the traced roofline + the photos. That left a saved quote showing
// "40 ft / 65 ft" with no visual evidence of where those came from: Naldo
// couldn't check the price, and staff verifying the quote (the whole premise of
// Phase A) would have had to re-run the analyzer from scratch rather than audit
// the measurement the customer was actually shown.
//
// So a self-serve quote now gets the SAME design a staff quote gets: the Street
// View photo with the analyzer's traced roofline seeded onto it as editable
// strands, plus the satellite image, its feet-per-pixel scale, and the satellite
// polylines. Reopening the quote shows the drawing that produced the number, and
// staff can correct the lines instead of starting over.
//
// Everything here is BEST-EFFORT and non-throwing: the quote + price are already
// saved by the time this runs, so a storage hiccup must never cost the customer
// their estimate. It only ever costs the visual.

import { createDesign, uploadDesignSatellite, updateDesignSatelliteLines } from '@/lib/designs';
import { sanitizeAnalysisSeed, type AnalysisSeed } from '@/lib/design/seedFromAnalysis';
import type { PhotoAnalysisResult } from '@/lib/photoAnalysis';

/**
 * Build the design seed from an analyzer result: the street-traced roofline
 * polylines (already normalized 0-1 by the analyzer), the per-unit detections,
 * and the AI's footage estimates — which pair with the drawn lines to calibrate
 * the scale yardstick, exactly as the staff builder's seed does.
 *
 * Pure: no I/O, so the mapping is unit-testable without Supabase or Google.
 */
export function buildSelfServeSeed(result: PhotoAnalysisResult): AnalysisSeed {
  return {
    lines: {
      santas: result.santasLines.map((l) => l.points),
      gingerbread: result.gingerbreadLines.map((l) => l.points),
    },
    detections: {
      miniLights: result.miniLightDetections,
      wreaths: result.wreathDetections,
      spritzers: result.spritzerDetections,
      garland: result.garlandDetections,
    },
    calibration: {
      santasFootage: result.santasFootage,
      gingerbreadFootage: result.gingerbreadFootage,
    },
  };
}

/** The satellite polylines, in the shape the design row + portal expect. */
export function buildSelfServeSatelliteLines(result: PhotoAnalysisResult) {
  return {
    santas: result.satelliteSantasLines.map((l) => ({ points: l.points, label: l.label })),
    gingerbread: result.satelliteGingerbreadLines.map((l) => ({ points: l.points, label: l.label })),
    c9: [],
  };
}

export type SelfServeDesignInput = {
  result: PhotoAnalysisResult;
  streetView: { base64: string; mediaType: string };
  satellite: { base64: string; mediaType: string };
  satelliteFeetPerPixel: number;
};

/**
 * Create the design for a self-serve quote: street photo + seeded roofline, then
 * (best-effort) the satellite image, its scale, and the satellite polylines.
 * Returns the design id, or null if nothing could be persisted.
 */
export async function persistSelfServeDesign(
  quoteId: string,
  input: SelfServeDesignInput,
): Promise<string | null> {
  let designId: string | null = null;
  try {
    const created = await createDesign({
      quoteId,
      photoBase64: input.streetView.base64,
      photoMediaType: input.streetView.mediaType,
      // sanitize mirrors POST /api/designs — the seed goes through the same
      // normalization the staff path uses, so a malformed polyline can't reach
      // the scene.
      seedAnalysis: sanitizeAnalysisSeed(buildSelfServeSeed(input.result)),
    });
    designId = created?.id ?? null;
    if (!designId) return null;
    if (created?.seedFailed) {
      console.warn('[selfServe] design seed failed — quote keeps its price, drawing may be blank');
    }
  } catch (err) {
    console.error('[selfServe] persistSelfServeDesign create failed:', err instanceof Error ? err.message : 'error');
    return null;
  }

  // Satellite half — separate try so a satellite failure still leaves the street
  // photo + traced roofline attached (the primary thing staff verify against).
  try {
    await uploadDesignSatellite(
      designId,
      input.satellite.base64,
      input.satellite.mediaType,
      input.satelliteFeetPerPixel,
    );
    // uploadDesignSatellite resets satellite_lines (a new image invalidates old
    // polylines), so write the traced lines AFTER it.
    await updateDesignSatelliteLines(designId, buildSelfServeSatelliteLines(input.result));
  } catch (err) {
    console.error('[selfServe] persistSelfServeDesign satellite failed:', err instanceof Error ? err.message : 'error');
  }

  return designId;
}
