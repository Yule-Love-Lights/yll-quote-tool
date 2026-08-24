// Deterministic satellite-roofline footage from drawn polylines. Companion to
// yardstickPpf.ts: same pure/no-I/O house style, same null-on-degenerate-input
// convention (null = "could not compute", never conflated with a real 0).
//
// WHY THIS EXISTS: the analyzer prompt currently asks the MODEL to do this
// arithmetic itself (sum each polyline's pixel distance × a feet-per-pixel
// scale). Measured against 30 live training_examples rows, the model's own
// STATED satellite footage disagrees with its own DRAWN polylines by 20.4% on
// average (11/30 rows > 25% off). This module makes the arithmetic exact and
// the disagreement visible — it does NOT replace the model's stated number
// anywhere money-adjacent (shadow mode only; see photoAnalysis.ts).
//
// THE 642x470 BUG THE MODEL'S OWN INSTRUCTION INVITES: the prompt tells the
// model to "multiply by 640" assuming a square satellite image. A real,
// live training row (12 Orient Ave, Northport) has a satellite image measured
// at 642x470 — NOT square, and its stored satellite_feet_per_pixel is null.
// This module always takes width and height as SEPARATE parameters and scales
// each normalized axis by its own dimension — never a single square constant
// — and returns null (not a guessed 0 or a NaN) when the scale is unknown.

export type NormalizedPoint = readonly [number, number];
export type FootagePolyline = { points: readonly NormalizedPoint[] };

const MIN_DIMENSION_PX = 1;

// SHARED CORE (2026-08-24 consolidation): the one polyline-segment-summing
// loop, reused by every typed wrapper below. Before this, the exact same
// "sum each segment's scaled Pythagorean distance" loop existed as THREE
// separate hand-written copies across the repo: this module's own (below),
// QuoteBuilder.tsx's local polylineLength (the staff-priced holiday
// satellite recompute — the ACTUAL money path), and
// src/lib/permanent/satelliteMeasure.ts's own deliberately-duplicated copy
// (its own comment says "avoid churning the holiday builder's internals" —
// left untouched here; it's under src/lib/permanent/**, out of scope for
// this change). This consolidation folds QuoteBuilder's copy into this
// shared core via polylineLengthAspectUnits below, leaving two: this module
// and the permanent one (a separate, later decision — see the PR body).
//
// No guards here — callers are responsible for validating their own scale
// inputs before calling. A non-finite per-segment result is skipped (that
// ONE segment contributes 0), never propagated as NaN/Infinity.
function sumSegmentLengths(
  lines: readonly FootagePolyline[] | null | undefined,
  xScale: number,
  yScale: number,
): number {
  let total = 0;
  for (const poly of lines ?? []) {
    const pts = poly?.points ?? [];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      const dx = (x2 - x1) * xScale;
      const dy = (y2 - y1) * yScale;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue; // skip a garbage segment, not the whole sum
      total += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return total;
}

/**
 * Total real-world footage traced by a set of polylines, given the pixel
 * dimensions of the image they were drawn on and a feet-per-pixel scale.
 * Pure — no I/O, no rounding (a caller rounds ONCE, on the final total,
 * never per-segment — rounding per-segment would compound drift over a
 * multi-segment ridge+sides polyline).
 *
 * Degenerate inputs, every one documented so a caller never has to guess:
 *  - `lines` null/undefined/empty          -> 0    (nothing drawn is a real,
 *                                                     legitimate zero)
 *  - a polyline with 0 or 1 points         -> contributes 0 (no segment to
 *                                                     measure)
 *  - one segment endpoint is non-finite    -> that ONE segment contributes 0;
 *    (NaN/Infinity)                            the rest of the polyline and
 *                                               every other line still sums
 *  - `imageWidthPx`/`imageHeightPx` missing,
 *    non-finite, or < 1px                  -> null (can't convert pixels to
 *                                                     feet without real,
 *                                                     positive dimensions)
 *  - `feetPerPixel` missing, non-finite,   -> null (can't convert without a
 *    zero, or negative                          real scale — this is the
 *                                                exact 642x470/null-scale
 *                                                training row)
 *
 * null always means "could not compute" and must never be treated the same
 * as a real 0 by a caller. This function never returns NaN or Infinity.
 *
 * Coordinates outside [0,1] are NOT clamped — a normalized point that
 * overshoots the frame is measured exactly as drawn. Flagging that as a
 * data-quality problem is the disagreement check's job, not this one's.
 */
export function footageFromLines(
  lines: readonly FootagePolyline[] | null | undefined,
  imageWidthPx: number | null | undefined,
  imageHeightPx: number | null | undefined,
  feetPerPixel: number | null | undefined,
): number | null {
  if (
    imageWidthPx == null || !Number.isFinite(imageWidthPx) || imageWidthPx < MIN_DIMENSION_PX ||
    imageHeightPx == null || !Number.isFinite(imageHeightPx) || imageHeightPx < MIN_DIMENSION_PX ||
    feetPerPixel == null || !Number.isFinite(feetPerPixel) || feetPerPixel <= 0
  ) {
    return null;
  }
  return sumSegmentLengths(lines, imageWidthPx, imageHeightPx) * feetPerPixel;
}

/**
 * QuoteBuilder-compatible aspect-ratio-normalized polyline length. This is
 * the SAME formula as the local `polylineLength` function QuoteBuilder.tsx
 * used to define itself (dx left in "image width = 1 unit" terms, dy scaled
 * by 1/aspect so a diagonal reflects the image's real width:height
 * proportion) — reused via the shared `sumSegmentLengths` core instead of a
 * second hand-written copy of the same loop. Returns a value in normalized
 * width-units; the CALLER still multiplies by its own pixel-width constant
 * and feet-per-pixel scale (unchanged from before this consolidation).
 *
 * Verified byte-for-byte parity with the pre-consolidation QuoteBuilder
 * formula (raw value AND both rounding conventions QuoteBuilder uses) across
 * every training_examples row with a valid satellite scale (70 row×line
 * combinations, 2026-08-24) — see the PR body for the comparison.
 *
 * `aspect` non-finite or <= 0 (never observed in the live app — QuoteBuilder
 * only ever sets it from a loaded image's real, positive naturalWidth /
 * naturalHeight — but the ORIGINAL unguarded formula would have silently
 * produced Infinity/NaN here) -> 0, never NaN/Infinity. This is strictly
 * SAFER than the code it replaces, not a change in any observed output.
 */
export function polylineLengthAspectUnits(
  lines: readonly FootagePolyline[] | null | undefined,
  aspect: number,
): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 0;
  return sumSegmentLengths(lines, 1, 1 / aspect);
}

// Threshold beyond which the model's own stated satellite footage and the
// footage computed from its own drawn polylines are treated as disagreeing.
// 25% — chosen from the live-corpus measurement (11/30 rows exceeded it,
// while the bulk of the corpus sits well under it: 20.4% average absolute
// disagreement across all 30 rows). Named + commented, not a silent magic
// number, per the repo's money-math convention.
export const SATELLITE_FOOTAGE_DISAGREEMENT_THRESHOLD_PCT = 0.25;

/**
 * True when the model's stated satellite footage and the footage computed
 * from its own drawn polylines disagree by MORE than
 * SATELLITE_FOOTAGE_DISAGREEMENT_THRESHOLD_PCT. Boundary is exclusive: a
 * difference exactly AT the threshold does not flag.
 *
 *  - `computedFootage` null (no scale/lines to compute from) -> false,
 *    nothing to compare
 *  - either input non-finite (NaN/Infinity)                  -> false,
 *    "cannot compare" rather than a spurious flag
 *  - both stated and computed are <= 0                       -> false,
 *    nothing drawn + nothing stated is agreement, not disagreement
 *  - stated <= 0 but computed > 0                             -> true,
 *    the model said "0 ft" while its own lines measure real footage
 */
export function satelliteFootageDisagrees(
  statedFootage: number,
  computedFootage: number | null,
): boolean {
  if (computedFootage == null) return false;
  if (!Number.isFinite(statedFootage) || !Number.isFinite(computedFootage)) return false;
  if (statedFootage <= 0 && computedFootage <= 0) return false;
  if (statedFootage <= 0) return true;
  const pct = Math.abs(computedFootage - statedFootage) / statedFootage;
  return pct > SATELLITE_FOOTAGE_DISAGREEMENT_THRESHOLD_PCT;
}
