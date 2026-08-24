// Placement evaluation harness — scores WHERE the AI's first-pass geometry
// landed against the staff-final geometry, not just whether the counts
// matched. Pure + I/O-free by design so it's trivially unit-testable; the
// only caller that touches Supabase is scripts/eval-placement.ts.
//
// Both sides of every comparison are expected in the SAME vocabulary
// sceneToFewShotPieces() already produces for staff-final scenes: normalized
// (0-1 of the street photo) roofline polylines + detection boxes. The AI's
// `original_analysis` (a PhotoAnalysisResult) is structurally compatible —
// it carries the same six fields, just with extra footage/satellite fields
// this module ignores.
//
// NULL VS 0 — read this before trusting any single number. A metric is
// `null` exactly when it is mathematically undefined (dividing by a
// population of zero), never as a stand-in for "bad" or "zero". The
// degenerate cases, spelled out at each function below:
//   - AI and staff BOTH report nothing for a category (e.g. no wreaths on
//     this house) → that's a correct "nothing here" call, not a gap.
//     Boxes: precision/recall/f1 = 1, IoU/distance = null (nothing to
//     average). Polylines: lengthRatio = 1, all distances = 0.
//   - Only one side reports nothing → the populated side's precision or
//     recall (whichever it defines) is 0, the other is null; distances are
//     null (there is no "nearest point" when one set is empty — reporting 0
//     would be a false perfect score, reporting Infinity would poison an
//     average). Polyline lengthRatio is null unless AI is also 0 (0/0 → 1).

import type {
  LineSegment,
  MiniLightDetection,
  WreathDetection,
  SpritzerDetection,
  GarlandDetection,
} from '@/lib/photoAnalysis';

// The detection vocabulary both the AI's original_analysis and
// sceneToFewShotPieces(final_scene) share. Structural typing — PhotoAnalysisResult
// and SceneFewShotPieces both satisfy this with fields to spare.
export type DetectionPieces = {
  santasLines: LineSegment[];
  gingerbreadLines: LineSegment[];
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  garlandDetections: GarlandDetection[];
};

export type Box = [number, number, number, number]; // [x, y, w, h] normalized 0-1

// COCO's canonical "correct detection" threshold is IoU >= 0.5, calibrated
// for pixel-precise human-drawn bounding boxes. Ours aren't that: a wreath/
// spritzer box is a SYNTHETIC square centered on a point and sized off the
// scene's yardstick (see sceneToFewShot.ts's centeredBox), so a box that's
// dead-center-correct but sized a bit differently than the AI guessed can
// still legitimately fall under 0.5 IoU. 0.3 is the loosest threshold still
// used in the object-detection literature (PASCAL VOC's original choice) and
// is a better fit for "is this roughly the same spot on the house" than a
// stricter box-shape match would be. scoreBoxes also accepts an explicit
// threshold so a caller can report the stricter number alongside this one.
export const IOU_MATCH_THRESHOLD = 0.3;

function boxArea(b: Box): number {
  return Math.max(0, b[2]) * Math.max(0, b[3]);
}

export function iou(a: Box, b: Box): number {
  const ax0 = a[0], ay0 = a[1], ax1 = a[0] + a[2], ay1 = a[1] + a[3];
  const bx0 = b[0], by0 = b[1], bx1 = b[0] + b[2], by1 = b[1] + b[3];
  const ix0 = Math.max(ax0, bx0);
  const iy0 = Math.max(ay0, by0);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  const interArea = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
  const unionArea = boxArea(a) + boxArea(b) - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

export function centroid(b: Box): [number, number] {
  return [b[0] + b[2] / 2, b[1] + b[3] / 2];
}

export function centroidDistance(a: Box, b: Box): number {
  const [ax, ay] = centroid(a);
  const [bx, by] = centroid(b);
  return Math.hypot(ax - bx, ay - by);
}

export type BoxScore = {
  threshold: number;
  aiCount: number;
  staffCount: number;
  matchedCount: number;
  unmatchedAiCount: number; // AI boxes nothing on staff's side claimed — false positives
  unmatchedStaffCount: number; // staff boxes the AI never found — misses
  meanIou: number | null; // over matched pairs only
  meanCentroidDistance: number | null; // over matched pairs only, normalized units
  precision: number | null; // matched / aiCount — null when aiCount is 0 (nothing to grade)
  recall: number | null; // matched / staffCount — null when staffCount is 0 (nothing to find)
  f1: number | null;
};

// Greedy one-to-one IoU matching (not globally-optimal Hungarian assignment
// — greedy is simpler, deterministic, and the corpus is small enough per
// category that the two rarely diverge). Every AI×staff pair at or above
// `threshold` is a matching candidate; candidates are consumed best-IoU
// first, each box usable at most once. A duplicate AI box competing with a
// real one for the same staff box loses if its IoU is lower, and becomes an
// unmatched (false-positive) box rather than silently double-counting.
export function scoreBoxes(
  aiBoxes: readonly Box[],
  staffBoxes: readonly Box[],
  threshold: number = IOU_MATCH_THRESHOLD,
): BoxScore {
  const aiCount = aiBoxes.length;
  const staffCount = staffBoxes.length;

  if (aiCount === 0 && staffCount === 0) {
    return {
      threshold, aiCount, staffCount, matchedCount: 0, unmatchedAiCount: 0, unmatchedStaffCount: 0,
      meanIou: null, meanCentroidDistance: null, precision: 1, recall: 1, f1: 1,
    };
  }

  type Pair = { i: number; j: number; iou: number };
  const candidates: Pair[] = [];
  for (let i = 0; i < aiCount; i++) {
    for (let j = 0; j < staffCount; j++) {
      const v = iou(aiBoxes[i], staffBoxes[j]);
      if (v >= threshold) candidates.push({ i, j, iou: v });
    }
  }
  // Best IoU first; index order breaks ties so the result is deterministic
  // regardless of input order equal-IoU ties arrive in.
  candidates.sort((a, b) => b.iou - a.iou || a.i - b.i || a.j - b.j);

  const usedAi = new Set<number>();
  const usedStaff = new Set<number>();
  const matched: Pair[] = [];
  for (const p of candidates) {
    if (usedAi.has(p.i) || usedStaff.has(p.j)) continue;
    usedAi.add(p.i);
    usedStaff.add(p.j);
    matched.push(p);
  }

  const matchedCount = matched.length;
  const unmatchedAiCount = aiCount - matchedCount;
  const unmatchedStaffCount = staffCount - matchedCount;

  const meanIou = matchedCount > 0 ? matched.reduce((s, p) => s + p.iou, 0) / matchedCount : null;
  const meanCentroidDistance = matchedCount > 0
    ? matched.reduce((s, p) => s + centroidDistance(aiBoxes[p.i], staffBoxes[p.j]), 0) / matchedCount
    : null;

  const precision = aiCount > 0 ? matchedCount / aiCount : null;
  const recall = staffCount > 0 ? matchedCount / staffCount : null;
  // precision/recall can only be null when its own population is 0, and a
  // 0-population side forces the OTHER side's rate to 0 whenever it's
  // populated (matchedCount is capped at min(aiCount, staffCount)) — so
  // "one is null, the other is a nonzero number" cannot occur. The f1
  // fallback below is defensive, not a real branch.
  const f1 = precision === 0 || recall === 0
    ? 0
    : precision != null && recall != null
      ? (2 * precision * recall) / (precision + recall)
      : null;

  return { threshold, aiCount, staffCount, matchedCount, unmatchedAiCount, unmatchedStaffCount, meanIou, meanCentroidDistance, precision, recall, f1 };
}

export type PolylineScore = {
  aiSegmentCount: number;
  staffSegmentCount: number;
  aiLengthNorm: number; // sum of segment lengths, normalized (0-1) units
  staffLengthNorm: number;
  lengthRatio: number | null; // aiLength / staffLength — the money-relevant number
  meanForwardDistance: number | null; // AI-sampled points -> nearest point on a staff segment
  meanBackwardDistance: number | null; // staff-sampled points -> nearest point on an AI segment
  medianForwardDistance: number | null;
  medianBackwardDistance: number | null;
  symmetricChamfer: number | null; // mean(forward, backward) — one number for "how far off"
};

// Distance in normalized units between samples this dense still resolves
// house-scale placement errors (a wrong side of the roof, a missed dormer)
// while staying cheap — the corpus's houses fit in well under 1000 samples
// per polyline set at this spacing.
const SAMPLE_STEP = 0.01;

function pointSegDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function sampleLine(points: readonly [number, number][], step: number = SAMPLE_STEP): [number, number][] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(segLen / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([x0 + t * (x1 - x0), y0 + t * (y1 - y0)]);
    }
  }
  out.push(points[points.length - 1]); // the sampling loop never emits t=1
  return out;
}

function minDistToLines(pt: readonly [number, number], lines: readonly LineSegment[]): number {
  let best = Infinity;
  for (const line of lines) {
    const pts = line.points;
    if (pts.length === 1) {
      best = Math.min(best, Math.hypot(pt[0] - pts[0][0], pt[1] - pts[0][1]));
      continue;
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      best = Math.min(best, pointSegDist(pt[0], pt[1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    }
  }
  return best;
}

function totalLength(lines: readonly LineSegment[]): number {
  let sum = 0;
  for (const line of lines) {
    const pts = line.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      sum += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    }
  }
  return sum;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function median(sortedXs: readonly number[]): number {
  const n = sortedXs.length;
  return n % 2 === 1 ? sortedXs[(n - 1) / 2] : (sortedXs[n / 2 - 1] + sortedXs[n / 2]) / 2;
}

// Symmetric Chamfer distance between two polyline sets, plus a total-length
// ratio (the quantity that actually drives billed footage).
export function scorePolylines(
  aiLines: readonly LineSegment[],
  staffLines: readonly LineSegment[],
): PolylineScore {
  const aiSegmentCount = aiLines.length;
  const staffSegmentCount = staffLines.length;
  const aiLengthNorm = totalLength(aiLines);
  const staffLengthNorm = totalLength(staffLines);

  const lengthRatio = staffLengthNorm > 0
    ? aiLengthNorm / staffLengthNorm
    : (aiLengthNorm === 0 ? 1 : null); // dividing by zero staff footage: only defined (as agreement) when AI also drew nothing

  if (aiSegmentCount === 0 && staffSegmentCount === 0) {
    return {
      aiSegmentCount, staffSegmentCount, aiLengthNorm: 0, staffLengthNorm: 0, lengthRatio: 1,
      meanForwardDistance: 0, meanBackwardDistance: 0, medianForwardDistance: 0, medianBackwardDistance: 0, symmetricChamfer: 0,
    };
  }
  if (aiSegmentCount === 0 || staffSegmentCount === 0) {
    // One side drew nothing — there is no "nearest point" to measure a
    // distance to. Reporting 0 would read as a perfect match; leave null.
    return {
      aiSegmentCount, staffSegmentCount, aiLengthNorm, staffLengthNorm, lengthRatio,
      meanForwardDistance: null, meanBackwardDistance: null, medianForwardDistance: null, medianBackwardDistance: null, symmetricChamfer: null,
    };
  }

  const aiSamples = aiLines.flatMap((l) => sampleLine(l.points));
  const staffSamples = staffLines.flatMap((l) => sampleLine(l.points));

  const forwardDists = aiSamples.map((p) => minDistToLines(p, staffLines)).sort((a, b) => a - b);
  const backwardDists = staffSamples.map((p) => minDistToLines(p, aiLines)).sort((a, b) => a - b);

  const meanForwardDistance = mean(forwardDists);
  const meanBackwardDistance = mean(backwardDists);

  return {
    aiSegmentCount, staffSegmentCount, aiLengthNorm, staffLengthNorm, lengthRatio,
    meanForwardDistance, meanBackwardDistance,
    medianForwardDistance: median(forwardDists), medianBackwardDistance: median(backwardDists),
    symmetricChamfer: (meanForwardDistance + meanBackwardDistance) / 2,
  };
}

export type ExampleScore = {
  santas: PolylineScore;
  gingerbread: PolylineScore;
  wreath: BoxScore;
  spritzer: BoxScore;
  garland: BoxScore;
  mini: BoxScore;
};

// Score one training example: every detection category, AI first-pass vs
// staff-final, both already in the shared DetectionPieces vocabulary.
export function scoreExample(
  ai: DetectionPieces,
  staff: DetectionPieces,
  threshold: number = IOU_MATCH_THRESHOLD,
): ExampleScore {
  return {
    santas: scorePolylines(ai.santasLines, staff.santasLines),
    gingerbread: scorePolylines(ai.gingerbreadLines, staff.gingerbreadLines),
    wreath: scoreBoxes(ai.wreathDetections.map((d) => d.box), staff.wreathDetections.map((d) => d.box), threshold),
    spritzer: scoreBoxes(ai.spritzerDetections.map((d) => d.box), staff.spritzerDetections.map((d) => d.box), threshold),
    garland: scoreBoxes(ai.garlandDetections.map((d) => d.box), staff.garlandDetections.map((d) => d.box), threshold),
    mini: scoreBoxes(ai.miniLightDetections.map((d) => d.box), staff.miniLightDetections.map((d) => d.box), threshold),
  };
}
