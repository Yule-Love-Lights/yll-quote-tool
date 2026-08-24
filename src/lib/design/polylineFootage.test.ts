import { describe, it, expect } from 'vitest';
import {
  footageFromLines,
  satelliteFootageDisagrees,
  SATELLITE_FOOTAGE_DISAGREEMENT_THRESHOLD_PCT,
  type FootagePolyline,
} from './polylineFootage';

const line = (points: [number, number][]): FootagePolyline => ({ points });

describe('footageFromLines', () => {
  // ── Degenerate inputs — every one must return a defined, documented value,
  // never NaN/Infinity. ─────────────────────────────────────────────────────

  it('returns 0 for an empty lines array (nothing drawn is a real zero)', () => {
    expect(footageFromLines([], 640, 640, 0.37)).toBe(0);
  });

  it('returns 0 when lines is null/undefined', () => {
    expect(footageFromLines(null, 640, 640, 0.37)).toBe(0);
    expect(footageFromLines(undefined, 640, 640, 0.37)).toBe(0);
  });

  it('a single-point polyline contributes 0 (no segment to measure)', () => {
    expect(footageFromLines([line([[0.5, 0.5]])], 640, 640, 0.37)).toBe(0);
  });

  it('an empty-points polyline contributes 0', () => {
    expect(footageFromLines([line([])], 640, 640, 0.37)).toBe(0);
  });

  it('returns null when feetPerPixel is missing (the 642x470/null-scale training row)', () => {
    expect(footageFromLines([line([[0, 0], [1, 0]])], 642, 470, null)).toBeNull();
    expect(footageFromLines([line([[0, 0], [1, 0]])], 642, 470, undefined)).toBeNull();
  });

  it('returns null when feetPerPixel is zero or negative', () => {
    expect(footageFromLines([line([[0, 0], [1, 0]])], 640, 640, 0)).toBeNull();
    expect(footageFromLines([line([[0, 0], [1, 0]])], 640, 640, -0.37)).toBeNull();
  });

  it('returns null when feetPerPixel is non-finite', () => {
    expect(footageFromLines([line([[0, 0], [1, 0]])], 640, 640, NaN)).toBeNull();
    expect(footageFromLines([line([[0, 0], [1, 0]])], 640, 640, Infinity)).toBeNull();
  });

  it('returns null when imageWidthPx/imageHeightPx are missing, non-finite, or <= 0', () => {
    expect(footageFromLines([line([[0, 0], [1, 0]])], null, 640, 0.37)).toBeNull();
    expect(footageFromLines([line([[0, 0], [1, 0]])], 640, null, 0.37)).toBeNull();
    expect(footageFromLines([line([[0, 0], [1, 0]])], 0, 640, 0.37)).toBeNull();
    expect(footageFromLines([line([[0, 0], [1, 0]])], 640, -1, 0.37)).toBeNull();
    expect(footageFromLines([line([[0, 0], [1, 0]])], NaN, 640, 0.37)).toBeNull();
  });

  it('never returns NaN or Infinity for any input combination tried above', () => {
    const results = [
      footageFromLines([], 640, 640, 0.37),
      footageFromLines([line([[0.5, 0.5]])], 640, 640, 0.37),
      footageFromLines([line([[0, 0], [1, 0]])], 640, 640, 0.37),
      footageFromLines([line([[0, 0], [Infinity, 0]])], 640, 640, 0.37),
    ];
    for (const r of results) {
      if (r !== null) expect(Number.isFinite(r)).toBe(true);
    }
  });

  it('skips a single segment with a non-finite endpoint, but still sums the rest', () => {
    // Segment 1 (0,0)->(Infinity,0) is garbage and contributes 0; segment 2
    // (0,0)->(1,0) is a clean 640px horizontal run.
    const poly = line([[0, 0], [Infinity, 0], [0, 0], [1, 0]]);
    // Points: p0=(0,0) p1=(Inf,0) p2=(0,0) p3=(1,0)
    // seg0-1: garbage, skipped (0). seg1-2: garbage, skipped (0).
    // seg2-3: (0,0)->(1,0), 640px * 0.37 ft/px = 236.8 ft
    const got = footageFromLines([poly], 640, 640, 0.37);
    expect(got).toBeCloseTo(236.8, 5);
  });

  // ── Real geometry — hand-computed fixtures ──────────────────────────────

  it('a single horizontal segment on a SQUARE image: hand-computed', () => {
    // Normalized (0.1,0.5) -> (0.9,0.5) on a 640x640 image, 0.37127 ft/px
    // (the live 12 Orient Ave scale). dx = 0.8 * 640 = 512px, dy = 0.
    // 512 * 0.37127 = 190.09024 ft.
    const got = footageFromLines([line([[0.1, 0.5], [0.9, 0.5]])], 640, 640, 0.37127);
    expect(got).toBeCloseTo(512 * 0.37127, 6);
  });

  it('the exact "front edge ~50ft" live-corpus disagreement fixture', () => {
    // From the brief: a segment labeled "front edge ~50ft" drawn 0.32 to 0.68
    // normalized x (flat, same y) on a 640px-wide image at 0.37127 ft/px is
    // reported as 85.5 ft (0.36 * 640 * 0.37127 = 85.500...).
    const got = footageFromLines([line([[0.32, 0.4], [0.68, 0.4]])], 640, 640, 0.37127);
    expect(got).toBeCloseTo(0.36 * 640 * 0.37127, 6);
    expect(got).toBeCloseTo(85.5, 1);
  });

  it('a NON-SQUARE image scales x by width and y by height SEPARATELY (the 642x470 bug the model prompt invites)', () => {
    // A pure-vertical run: (0.5,0.2) -> (0.5,0.8) on a 642x470 image.
    // dx = 0 * 642 = 0px. dy = 0.6 * 470 = 282px. Distance = 282px.
    // If the code wrongly used a single "square" dimension (e.g. 642 for
    // both axes, mirroring the model's own hardcoded-640 assumption), this
    // would compute 0.6 * 642 = 385.2px instead — a materially different
    // (and wrong) number. feetPerPixel here uses a nominal 0.3 ft/px.
    const got = footageFromLines([line([[0.5, 0.2], [0.5, 0.8]])], 642, 470, 0.3);
    expect(got).toBeCloseTo(282 * 0.3, 6);
    expect(got).not.toBeCloseTo(385.2 * 0.3, 1); // the wrong square-assumption answer
  });

  it('a DIAGONAL segment on a non-square image: hand-computed Pythagorean fixture', () => {
    // (0,0) -> (1,1) on a 642x470 image. dx = 1*642=642px, dy=1*470=470px.
    // length = sqrt(642^2 + 470^2) = sqrt(412164 + 220900) = sqrt(633064)
    const expectedPx = Math.sqrt(642 * 642 + 470 * 470);
    const got = footageFromLines([line([[0, 0], [1, 1]])], 642, 470, 0.3);
    expect(got).toBeCloseTo(expectedPx * 0.3, 6);
  });

  it('sums MULTIPLE SEGMENTS within one multi-point polyline (round once at the end, never per segment)', () => {
    // A 3-point polyline: (0,0)->(0.5,0)->(0.5,0.5) on 640x640, 0.37127 ft/px.
    // seg1: dx=0.5*640=320px, dy=0 -> 320px
    // seg2: dx=0, dy=0.5*640=320px -> 320px
    // total px = 640, total ft = 640 * 0.37127
    const got = footageFromLines([line([[0, 0], [0.5, 0], [0.5, 0.5]])], 640, 640, 0.37127);
    expect(got).toBeCloseTo(640 * 0.37127, 6);
  });

  it('sums across MULTIPLE POLYLINES in the array (the live corpus never exceeds 1 santas / 4 gingerbread segments today, but the summing code must not special-case a single-line set)', () => {
    // Three separate 1-segment polylines (mirrors a real gingerbread ridge +
    // two sides), each 100px on a 640x640 image at 0.5 ft/px = 50ft each.
    const lines = [
      line([[0, 0], [0.15625, 0]]), // 100px horizontal
      line([[0, 0.5], [0.15625, 0.5]]), // 100px horizontal
      line([[0, 0.8], [0.15625, 0.8]]), // 100px horizontal
    ];
    const got = footageFromLines(lines, 640, 640, 0.5);
    expect(got).toBeCloseTo(300 * 0.5, 6);
  });

  it('a FIVE-segment single polyline (larger than any segment count seen in the live corpus today) sums correctly', () => {
    // 5 unit-length horizontal steps of 0.1 normalized width each, 1000px
    // wide image, 1 ft/px. Each step = 100px. Total = 500px = 500ft.
    const pts: [number, number][] = [[0, 0], [0.1, 0], [0.2, 0], [0.3, 0], [0.4, 0], [0.5, 0]];
    const got = footageFromLines([line(pts)], 1000, 1000, 1);
    expect(got).toBeCloseTo(500, 6);
  });

  it('does NOT clamp coordinates outside [0,1] — computes the geometry as drawn (a data-quality signal for the disagreement flag, not this module\'s job)', () => {
    // (-0.1, 0) -> (1.1, 0) on a 640x640 image: dx = 1.2 * 640 = 768px.
    const got = footageFromLines([line([[-0.1, 0], [1.1, 0]])], 640, 640, 0.5);
    expect(got).toBeCloseTo(768 * 0.5, 6);
  });

  it('floating-point accumulation over many small segments matches one big segment (no per-segment rounding drift)', () => {
    // 100 tiny 0.01-wide steps should sum to the same length as one full-
    // width segment, to within float epsilon (this module never rounds
    // internally — only a caller rounds, once, at the very end).
    const manySteps: [number, number][] = [[0, 0]];
    for (let i = 1; i <= 100; i++) manySteps.push([i * 0.01, 0]);
    const many = footageFromLines([line(manySteps)], 640, 640, 0.37127);
    const one = footageFromLines([line([[0, 0], [1, 0]])], 640, 640, 0.37127);
    expect(many).toBeCloseTo(one as number, 9);
  });
});

describe('satelliteFootageDisagrees', () => {
  it('flags when computed differs from stated by MORE than the threshold', () => {
    // stated 40, computed 60 -> 50% off, threshold is 25%.
    expect(satelliteFootageDisagrees(40, 60)).toBe(true);
  });

  it('does NOT flag when the difference is within the threshold', () => {
    // stated 40, computed 45 -> 12.5% off.
    expect(satelliteFootageDisagrees(40, 45)).toBe(false);
  });

  it('the boundary is exclusive: exactly the threshold does not flag, one cent over does', () => {
    const stated = 100;
    const atThreshold = stated * (1 + SATELLITE_FOOTAGE_DISAGREEMENT_THRESHOLD_PCT);
    const overThreshold = atThreshold + 0.01;
    expect(satelliteFootageDisagrees(stated, atThreshold)).toBe(false);
    expect(satelliteFootageDisagrees(stated, overThreshold)).toBe(true);
  });

  it('returns false when there is nothing computed to compare (null)', () => {
    expect(satelliteFootageDisagrees(40, null)).toBe(false);
  });

  it('returns false when both stated and computed are 0/non-positive (nothing drawn, nothing stated — agreement)', () => {
    expect(satelliteFootageDisagrees(0, 0)).toBe(false);
  });

  it('flags when the model states 0 but the drawn lines measure real footage', () => {
    expect(satelliteFootageDisagrees(0, 50)).toBe(true);
  });

  it('never throws or returns NaN/undefined for non-finite inputs — treated as "cannot compare"', () => {
    expect(satelliteFootageDisagrees(NaN, 50)).toBe(false);
    expect(satelliteFootageDisagrees(40, NaN)).toBe(false);
    expect(satelliteFootageDisagrees(40, Infinity)).toBe(false);
  });
});
