// Placement evaluation harness — scores WHERE the AI's first-pass geometry
// landed against the staff-final geometry, not just whether the counts
// matched. Pure + I/O-free by design so it is trivially unit-testable; the
// only caller that touches Supabase is scripts/eval-placement.ts.
//
// Both sides of every comparison are expected in the SAME vocabulary
// sceneToFewShotPieces() already produces for staff-final scenes: normalized
// (0-1 of the street photo) roofline polylines + detection boxes. The AI's
// `original_analysis` (a PhotoAnalysisResult) is structurally compatible —
// it carries the same six fields, just with extra footage/satellite fields
// this module ignores.
//
// POINT vs AREA CATEGORIES — read this before adding a metric or reading one.
// Wreath and spritzer are POINT-LIKE: a single physical spot (a doorway, a
// stake) rendered as a SYNTHETIC box centered on that point (see centeredBox
// in sceneToFewShot.ts), not a real extent. Measured on this corpus, AI
// spritzer boxes average about 0.032 x 0.041 normalized (roughly 21px on a
// 640px photo); two boxes that small need centres within roughly half a
// box-width (about 0.015 normalized) to reach IoU 0.3, so IoU is close to a
// binary pass/fail at this box size and cannot tell "12px off, basically
// right" from "wrong side of the house". Point-like categories are matched
// on CENTROID DISTANCE instead (scorePoints), with IoU kept as a secondary,
// informational column. MiniArea and garland are real AREAS (a wrapped
// bush, a railing run) where IoU is the appropriate primary metric
// (scoreBoxes) — box shape genuinely carries placement information there.
//
// HISTORY NOTE (do not repeat this mistake): an earlier version of this
// module reported one meanCentroidDistance computed ONLY over IoU-matched
// pairs, for every box category. That is a self-selecting sample of
// already-near-identical boxes — it will always look near-perfect (this
// module's own first pass measured 0.001-0.003 normalized units on wreath
// and spritzer, next to single-digit-percent F1 on the exact same data) and
// tells you nothing about the unmatched majority. Every "mean distance" this
// module reports now comes from nearestCentroidDistances, an UNCONSTRAINED
// nearest-neighbor pass — every staff item gets its true nearest-AI
// distance whenever the example has any AI item in that category, not just
// the ones that happened to already overlap.
//
// NULL VS 0 — a metric is `null` exactly when it is mathematically undefined
// (dividing by a population of zero), never as a stand-in for "bad" or
// "zero". The degenerate cases, spelled out at each function below:
//   - AI and staff BOTH report nothing for a category (e.g. no wreaths on
//     this house) -> that is a correct "nothing here" call, not a gap.
//     precision/recall/f1 = 1, IoU/distance = null (nothing to average).
//     Polylines: lengthRatio = 1, all distances = 0.
//   - Only one side reports nothing -> the populated side's precision or
//     recall (whichever it defines) is 0, the other is null; a staff item
//     with zero AI candidates in its example gets a null nearest-distance
//     (not a false 0, not Infinity poisoning an average). Polyline
//     lengthRatio is null unless AI is also 0 (0/0 -> 1).

import type {
  LineSegment,
  MiniLightDetection,
  WreathDetection,
  SpritzerDetection,
  GarlandDetection,
} from '@/lib/photoAnalysis';
import { isWreath, isSpritzer, isMiniArea, isGarland } from '../design/sceneTypes';
import type { Scene, SceneItem } from '../design/sceneTypes';

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
// for pixel-precise human-drawn bounding boxes. Ours are not that: an AREA
// box (miniArea, garland) is drawn/measured with real extent, so 0.5 would
// be defensible there too, but 0.3 (PASCAL VOC's original, the loosest
// threshold still used in the literature) is a better fit for "is this
// roughly the same spot" given our boxes are AI-guessed, not human-audited.
// scoreBoxes also accepts an explicit threshold so a caller can report a
// stricter number alongside this one. NOTE: point-like categories (wreath,
// spritzer) do NOT use this as their primary metric — see scorePoints and
// CENTROID_MATCH_THRESHOLD below.
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

function mean(xs: readonly number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function median(sortedXs: readonly number[]): number {
  const n = sortedXs.length;
  return n % 2 === 1 ? sortedXs[(n - 1) / 2] : (sortedXs[n / 2 - 1] + sortedXs[n / 2]) / 2;
}

// UNCONSTRAINED nearest-neighbor distance from every box in `fromBoxes` to
// its closest box in `toBoxes`, by centroid — no threshold, no one-to-one
// assignment. `null` only when `toBoxes` is empty (nothing to measure a
// distance to, a total miss — never a false 0). This is the shared, HONEST
// distance metric every distance-reporting function below is built on (see
// the HISTORY NOTE above for why "only average the pairs that already
// matched" was wrong).
function nearestCentroidDistances(fromBoxes: readonly Box[], toBoxes: readonly Box[]): (number | null)[] {
  if (toBoxes.length === 0) return fromBoxes.map(() => null);
  return fromBoxes.map((f) => {
    let best = Infinity;
    for (const t of toBoxes) best = Math.min(best, centroidDistance(f, t));
    return best;
  });
}

export type BoxScore = {
  threshold: number;
  aiCount: number;
  staffCount: number;
  matchedCount: number;
  unmatchedAiCount: number; // AI boxes nothing on staff's side claimed — false positives
  unmatchedStaffCount: number; // staff boxes the AI never found — misses
  meanIou: number | null; // over IoU-threshold-matched pairs only (IoU is the primary metric here, so this self-selection is fine)
  meanCentroidDistance: number | null; // UNCONSTRAINED nearest-neighbor mean (staff -> nearest AI), see nearestCentroidDistances
  precision: number | null; // matched / aiCount — null when aiCount is 0 (nothing to grade)
  recall: number | null; // matched / staffCount — null when staffCount is 0 (nothing to find)
  f1: number | null;
};

// Greedy one-to-one IoU matching (not globally-optimal Hungarian assignment
// — greedy is simpler, deterministic, and the corpus is small enough per
// category that the two rarely diverge). Every AI x staff pair at or above
// `threshold` is a matching candidate; candidates are consumed best-IoU
// first, each box usable at most once. A duplicate AI box competing with a
// real one for the same staff box loses if its IoU is lower, and becomes an
// unmatched (false-positive) box rather than silently double-counting.
//
// Intended for AREA categories (miniArea, garland) where IoU genuinely
// reflects placement quality. For POINT categories (wreath, spritzer) use
// scorePoints instead — see the file header.
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

  // FIXED (see the file-header HISTORY NOTE): unconstrained nearest-neighbor
  // distance, staff -> nearest AI, not an average over only the IoU-matched
  // pairs. `null` only when there is no AI box in this category at all.
  const rawDistances = nearestCentroidDistances(staffBoxes, aiBoxes).filter((d): d is number => d !== null);
  const meanCentroidDistance = rawDistances.length > 0 ? mean(rawDistances) : null;

  const precision = aiCount > 0 ? matchedCount / aiCount : null;
  const recall = staffCount > 0 ? matchedCount / staffCount : null;
  // precision/recall can only be null when its own population is 0, and a
  // 0-population side forces the OTHER side's rate to 0 whenever it is
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

// Point-match threshold: chosen as roughly one AI-spritzer-box-width on this
// corpus (see the file header's box-size measurement) — a distance at which
// a placement is still clearly "the same fixture, not a different one" —
// and it doubles as one of the histogram buckets below so the pass-rate and
// the full distribution stay comparable at a glance.
export const CENTROID_MATCH_THRESHOLD = 0.05;

// Named distances (normalized units) the corpus-wide report buckets the full
// nearest-neighbor distribution into. Chosen to match the exact thresholds
// used to spot-check this module's numbers against an independent nearest-
// neighbor pass over the live corpus, so the two stay directly comparable.
export const POINT_DISTANCE_HISTOGRAM_THRESHOLDS: readonly number[] = [0.02, 0.05, 0.10];

export type PointScore = {
  threshold: number; // CENTROID_MATCH_THRESHOLD (or override) — the matched/unmatched cutoff below
  aiCount: number;
  staffCount: number;
  matchedCount: number;
  unmatchedAiCount: number;
  unmatchedStaffCount: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  // Full nearest-neighbor distribution, staff -> nearest AI centroid,
  // UNCONSTRAINED by `threshold` (see nearestCentroidDistances). This is the
  // PRIMARY quality signal for point categories — a single pass/fail rate
  // hides whether a "miss" was 6% of the image off or on the opposite side
  // of the house.
  meanNearestDistance: number | null;
  medianNearestDistance: number | null;
  // The raw sorted nearest-distance values behind mean/median above (staff
  // points with an AI candidate only — see noAiCandidateCount for the rest).
  // Exposed so a corpus-wide report can pool distances across many examples
  // into one TRUE median/histogram instead of averaging per-example medians,
  // which is not the same number.
  distances: number[];
  // Cumulative counts/fractions of staff points within each named distance —
  // fraction is out of ALL staff points (staffCount), not just the ones with
  // an AI candidate, matching how "25% of staff spritzers had an AI guess
  // within 0.02" should read.
  distanceHistogram: { threshold: number; count: number; fraction: number | null }[];
  noAiCandidateCount: number; // staff points whose example had zero AI points in this category at all
  iou: BoxScore; // secondary/informational cross-reference against the IoU-based metric
};

// Point-like categories (wreath, spritzer) — see the file header for why
// centroid distance, not IoU, is the primary metric here. Matching mirrors
// scoreBoxes' greedy one-to-one algorithm exactly, just with "distance <=
// threshold, closest first" in place of "IoU >= threshold, highest first".
export function scorePoints(
  aiBoxes: readonly Box[],
  staffBoxes: readonly Box[],
  threshold: number = CENTROID_MATCH_THRESHOLD,
  histogramThresholds: readonly number[] = POINT_DISTANCE_HISTOGRAM_THRESHOLDS,
): PointScore {
  const aiCount = aiBoxes.length;
  const staffCount = staffBoxes.length;
  const iouScore = scoreBoxes(aiBoxes, staffBoxes); // informational only — see the `iou` field doc

  if (aiCount === 0 && staffCount === 0) {
    return {
      threshold, aiCount, staffCount, matchedCount: 0, unmatchedAiCount: 0, unmatchedStaffCount: 0,
      precision: 1, recall: 1, f1: 1,
      meanNearestDistance: null, medianNearestDistance: null, distances: [],
      distanceHistogram: histogramThresholds.map((t) => ({ threshold: t, count: 0, fraction: null })),
      noAiCandidateCount: 0, iou: iouScore,
    };
  }

  type Pair = { i: number; j: number; d: number };
  const candidates: Pair[] = [];
  for (let i = 0; i < aiCount; i++) {
    for (let j = 0; j < staffCount; j++) {
      const d = centroidDistance(aiBoxes[i], staffBoxes[j]);
      if (d <= threshold) candidates.push({ i, j, d });
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);

  const usedAi = new Set<number>();
  const usedStaff = new Set<number>();
  let matchedCount = 0;
  for (const c of candidates) {
    if (usedAi.has(c.i) || usedStaff.has(c.j)) continue;
    usedAi.add(c.i);
    usedStaff.add(c.j);
    matchedCount++;
  }

  const unmatchedAiCount = aiCount - matchedCount;
  const unmatchedStaffCount = staffCount - matchedCount;
  const precision = aiCount > 0 ? matchedCount / aiCount : null;
  const recall = staffCount > 0 ? matchedCount / staffCount : null;
  const f1 = precision === 0 || recall === 0
    ? 0
    : precision != null && recall != null
      ? (2 * precision * recall) / (precision + recall)
      : null;

  const rawDistances = nearestCentroidDistances(staffBoxes, aiBoxes);
  const noAiCandidateCount = rawDistances.filter((d) => d === null).length;
  const distances = rawDistances.filter((d): d is number => d !== null).sort((a, b) => a - b);
  const meanNearestDistance = distances.length > 0 ? mean(distances) : null;
  const medianNearestDistance = distances.length > 0 ? median(distances) : null;
  const distanceHistogram = histogramThresholds.map((t) => {
    const count = distances.filter((d) => d <= t).length;
    return { threshold: t, count, fraction: staffCount > 0 ? count / staffCount : null };
  });

  return {
    threshold, aiCount, staffCount, matchedCount, unmatchedAiCount, unmatchedStaffCount,
    precision, recall, f1,
    meanNearestDistance, medianNearestDistance, distances, distanceHistogram, noAiCandidateCount, iou: iouScore,
  };
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
  wreath: PointScore; // point-like — centroid distance primary, see file header
  spritzer: PointScore; // point-like — centroid distance primary, see file header
  garland: BoxScore; // area — IoU primary
  mini: BoxScore; // area — IoU primary
};

// Score one training example: every detection category, AI first-pass vs
// staff-final, both already in the shared DetectionPieces vocabulary.
export function scoreExample(
  ai: DetectionPieces,
  staff: DetectionPieces,
  boxThreshold: number = IOU_MATCH_THRESHOLD,
  pointThreshold: number = CENTROID_MATCH_THRESHOLD,
): ExampleScore {
  return {
    santas: scorePolylines(ai.santasLines, staff.santasLines),
    gingerbread: scorePolylines(ai.gingerbreadLines, staff.gingerbreadLines),
    wreath: scorePoints(ai.wreathDetections.map((d) => d.box), staff.wreathDetections.map((d) => d.box), pointThreshold),
    spritzer: scorePoints(ai.spritzerDetections.map((d) => d.box), staff.spritzerDetections.map((d) => d.box), pointThreshold),
    garland: scoreBoxes(ai.garlandDetections.map((d) => d.box), staff.garlandDetections.map((d) => d.box), boxThreshold),
    mini: scoreBoxes(ai.miniLightDetections.map((d) => d.box), staff.miniLightDetections.map((d) => d.box), boxThreshold),
  };
}

// ---- Seed-acceptance rate ------------------------------------------------
//
// A geometry-free quality signal: the fraction of final-scene items that are
// still the AI's ORIGINALLY-SEEDED item. seedFromAnalysis.ts's own
// REPLACEMENT RULE comment is the source of truth here: "AI-seeded items
// carry a seed- id prefix. Re-seeding replaces ONLY seed-* items" — an
// item's id does not change from being dragged or resized (the editor's
// Konva nodes and scene items are updated in place, see e.g.
// editor-core/spritzer.ts), only from being deleted and redrawn. So a
// surviving seed- id means "staff never threw this detection away and
// started over" — it does NOT prove staff left the item's position
// untouched, only that they built on top of the AI's guess rather than
// discarding it. Needs no geometry, no photo dimensions, no matching.

export type AcceptanceCategory = 'wreath' | 'spritzer' | 'miniArea' | 'garland';

export type AcceptanceRate = {
  category: AcceptanceCategory;
  total: number;
  seeded: number; // still carries a seed- id (see doc comment above)
  rate: number | null; // seeded / total — null when total is 0 (nothing of this kind in the final scene)
};

const SEED_ID_PREFIX = 'seed-';

export function computeSeedAcceptance(scene: Scene): AcceptanceRate[] {
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  const counters: Record<AcceptanceCategory, { total: number; seeded: number }> = {
    wreath: { total: 0, seeded: 0 },
    spritzer: { total: 0, seeded: 0 },
    miniArea: { total: 0, seeded: 0 },
    garland: { total: 0, seeded: 0 },
  };
  for (const item of items) {
    let category: AcceptanceCategory | null = null;
    if (isWreath(item)) category = 'wreath';
    else if (isSpritzer(item)) category = 'spritzer';
    else if (isMiniArea(item)) category = 'miniArea';
    else if (isGarland(item)) category = 'garland';
    if (!category) continue;
    counters[category].total++;
    if (typeof item.id === 'string' && item.id.startsWith(SEED_ID_PREFIX)) counters[category].seeded++;
  }
  return (Object.keys(counters) as AcceptanceCategory[]).map((category) => {
    const { total, seeded } = counters[category];
    return { category, total, seeded, rate: total > 0 ? seeded / total : null };
  });
}
