// Permanent satellite measurement (#88 / S23, per Jason): derive each side's
// billed footage + BOM corner count from the roofline polylines drawn on the
// top-down satellite view. Permanent bills from these NUMBERS (not the design),
// so the money math lives here — pure + tested — not buried in the builder.
//
//   • footage — the aspect-corrected polyline length × Google's feet-per-pixel
//     (address pulls carry the scale; a manual satellite upload has none, so
//     footage is null → the operator types it). Rounded UP to the next 5-ft
//     step (#139, Jason S24 — permanent bills in 5-ft increments; the builder
//     inputs round hand-typed footage the same way on blur).
//   • corners — every polyline vertex incl. endpoints (Naldo's rule: a run
//     traced start→corner→end = 3). Each corner consumes 3 single lights in the
//     BOM. SCALE-FREE, so a no-scale upload still gets corners from the trace.

import { roundFootageUpTo5 } from './types';

export type SatMeasureLine = { points: [number, number][] };

// The satellite is 640×640 at zoom=20 (Static Maps) — mirrors QuoteBuilder.SAT_PX.
const SAT_PX = 640;

// Aspect-corrected normalized polyline length — mirrors QuoteBuilder.polylineLength
// (dx in width-units; dy scaled by 1/aspect so diagonals reflect real pixels).
// Duplicated (a few lines) rather than shared to avoid churning the holiday
// builder's internals; the test below locks the math.
function polylineLength(lines: SatMeasureLine[], aspect: number): number {
  const yScale = aspect > 0 ? 1 / aspect : 1;
  let total = 0;
  for (const line of lines) {
    const pts = line?.points ?? [];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      const dx = x2 - x1;
      const dy = (y2 - y1) * yScale;
      total += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return total;
}

function cornerCount(lines: SatMeasureLine[]): number {
  return lines.reduce((n, l) => {
    const verts = l?.points?.length ?? 0;
    return n + (verts >= 2 ? verts : 0);
  }, 0);
}

export type SideMeasure = { footage: number | null; corners: number };

/**
 * Derive one house side's footage (rounded UP to the next 5-ft step, or null
 * when there's no satellite scale) + corner count from its drawn polylines.
 */
export function deriveSideMeasure(
  lines: SatMeasureLine[],
  feetPerPixel: number | null,
  aspect: number,
): SideMeasure {
  const corners = cornerCount(lines);
  const footage =
    feetPerPixel != null && feetPerPixel > 0
      ? roundFootageUpTo5(polylineLength(lines, aspect) * SAT_PX * feetPerPixel)
      : null;
  return { footage, corners };
}
