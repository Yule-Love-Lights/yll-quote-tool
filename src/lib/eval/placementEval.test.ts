import { describe, it, expect } from 'vitest';
import {
  iou,
  centroidDistance,
  scoreBoxes,
  scorePoints,
  scorePolylines,
  scoreExample,
  computeSeedAcceptance,
  IOU_MATCH_THRESHOLD,
  CENTROID_MATCH_THRESHOLD,
  type Box,
  type DetectionPieces,
} from './placementEval';
import type { LineSegment } from '@/lib/photoAnalysis';
import type { Scene, WreathItem, SpritzerItem, MiniAreaItem, GarlandItem, StrandItem } from '../design/sceneTypes';

// Recursively walks a result object/array and asserts every number field is
// neither NaN nor Infinity — used to sweep degenerate cases without having
// to enumerate every nested field (scorePoints/scoreBoxes results nest an
// `iou`/`distanceHistogram` sub-object).
function assertAllNumbersFinite(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isNaN(value)).toBe(false);
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertAllNumbersFinite(v);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) assertAllNumbersFinite(v);
  }
}

// ---- iou / centroidDistance primitives ----------------------------------

describe('iou', () => {
  it('returns 1 for two identical boxes', () => {
    const b: Box = [0.1, 0.1, 0.2, 0.2];
    expect(iou(b, b)).toBeCloseTo(1, 10);
  });

  it('returns 0 for two boxes that do not overlap at all', () => {
    expect(iou([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1])).toBe(0);
  });

  it('computes a partial overlap correctly', () => {
    // [0,0,1,1] area 1; [0.5,0,1,1] area 1; intersection [0.5,0,0.5,1] area 0.5
    // union = 1 + 1 - 0.5 = 1.5 -> iou = 0.5/1.5
    const v = iou([0, 0, 1, 1], [0.5, 0, 1, 1]);
    expect(v).toBeCloseTo(1 / 3, 10);
  });

  it('does not divide by zero for two zero-area boxes (no overlap, no union)', () => {
    expect(iou([0, 0, 0, 0], [0, 0, 0, 0])).toBe(0);
  });
});

describe('centroidDistance', () => {
  it('is 0 for two boxes sharing a centroid', () => {
    expect(centroidDistance([0, 0, 0.2, 0.2], [0.05, 0.05, 0.1, 0.1])).toBeCloseTo(0, 10);
  });

  it('computes straight-line distance between centroids', () => {
    // centroid of [0,0,0,0] at (0,0); centroid of a box at (0.3,0.4)
    const d = centroidDistance([0, 0, 0, 0], [0, 0, 0.6, 0.8]);
    expect(d).toBeCloseTo(0.5, 10); // 3-4-5 triangle scaled
  });
});

// ---- scoreBoxes (area categories: miniArea, garland) -----------------------

describe('scoreBoxes', () => {
  it('scores a perfect one-to-one match as matched with IoU 1 and f1 1', () => {
    const boxes: Box[] = [[0.1, 0.1, 0.2, 0.2], [0.5, 0.5, 0.1, 0.1]];
    const s = scoreBoxes(boxes, boxes);
    expect(s.matchedCount).toBe(2);
    expect(s.unmatchedAiCount).toBe(0);
    expect(s.unmatchedStaffCount).toBe(0);
    expect(s.meanIou).toBeCloseTo(1, 10);
    expect(s.meanCentroidDistance).toBe(0);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });

  it('scores a total miss (no box anywhere near another) as all unmatched, but still reports the real nearest-neighbor distance', () => {
    const ai: Box[] = [[0, 0, 0.05, 0.05]];
    const staff: Box[] = [[0.9, 0.9, 0.05, 0.05]];
    const s = scoreBoxes(ai, staff);
    expect(s.matchedCount).toBe(0);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(1);
    expect(s.meanIou).toBeNull(); // no IoU-threshold match — this stays IoU-matched-only, appropriately, since IoU is primary here
    // meanCentroidDistance is UNCONSTRAINED (fixed per the module's HISTORY
    // NOTE): both boxes exist, so there's a real nearest-neighbor distance
    // even though nothing matched. Centroids (0.025,0.025) and (0.925,0.925).
    expect(s.meanCentroidDistance).toBeCloseTo(0.9 * Math.SQRT2, 6);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
  });

  it('scores a partial match: one AI box hits, one AI box is a false positive, one staff box is missed', () => {
    const ai: Box[] = [[0.1, 0.1, 0.2, 0.2], [0.9, 0.9, 0.05, 0.05]];
    const staff: Box[] = [[0.1, 0.1, 0.2, 0.2], [0.5, 0.5, 0.05, 0.05]];
    const s = scoreBoxes(ai, staff);
    expect(s.matchedCount).toBe(1);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(1);
    expect(s.precision).toBeCloseTo(0.5, 10);
    expect(s.recall).toBeCloseTo(0.5, 10);
    expect(s.f1).toBeCloseTo(0.5, 10);
  });

  it('does not match two boxes whose overlap is below the IoU threshold', () => {
    // Overlap is small relative to each box's area — construct an IoU well under 0.3.
    const ai: Box[] = [[0, 0, 0.1, 0.1]];
    const staff: Box[] = [[0.08, 0.08, 0.1, 0.1]]; // intersection 0.02x0.02=0.0004, union ~0.0196 -> iou ~0.02
    const s = scoreBoxes(ai, staff, IOU_MATCH_THRESHOLD);
    expect(s.matchedCount).toBe(0);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(1);
  });

  it('gives the higher-IoU box the match when two AI boxes compete for one staff box, leaving the loser unmatched', () => {
    const staffBox: Box = [0.4, 0.4, 0.2, 0.2];
    const goodAi: Box = [0.4, 0.4, 0.2, 0.2]; // identical -> iou 1
    const worseAi: Box = [0.45, 0.45, 0.2, 0.2]; // shifted -> lower but still >= threshold
    const s = scoreBoxes([worseAi, goodAi], [staffBox]);
    expect(s.matchedCount).toBe(1);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(0);
    expect(s.meanIou).toBeCloseTo(1, 10); // the winning pair, not an average with the loser
  });

  it('reports a vacuous perfect score when neither side has any boxes for this category', () => {
    const s = scoreBoxes([], []);
    expect(s).toMatchObject({
      aiCount: 0, staffCount: 0, matchedCount: 0, unmatchedAiCount: 0, unmatchedStaffCount: 0,
      meanIou: null, meanCentroidDistance: null, precision: 1, recall: 1, f1: 1,
    });
  });

  it('reports precision 0 / recall null / f1 0 when the AI hallucinates boxes the staff never placed', () => {
    const s = scoreBoxes([[0.1, 0.1, 0.1, 0.1], [0.6, 0.6, 0.1, 0.1]], []);
    expect(s.aiCount).toBe(2);
    expect(s.staffCount).toBe(0);
    expect(s.matchedCount).toBe(0);
    expect(s.precision).toBe(0);
    expect(s.recall).toBeNull();
    expect(s.f1).toBe(0);
    expect(s.meanCentroidDistance).toBeNull(); // no staff box to measure FROM
  });

  it('reports recall 0 / precision null / f1 0 when the AI misses every staff-placed box', () => {
    const s = scoreBoxes([], [[0.1, 0.1, 0.1, 0.1]]);
    expect(s.aiCount).toBe(0);
    expect(s.staffCount).toBe(1);
    expect(s.matchedCount).toBe(0);
    expect(s.precision).toBeNull();
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.meanCentroidDistance).toBeNull(); // no AI box to measure TO
  });

  it('never produces NaN or Infinity in any numeric field across the degenerate cases above', () => {
    const cases: [Box[], Box[]][] = [[[], []], [[[0, 0, 0.1, 0.1]], []], [[], [[0, 0, 0.1, 0.1]]]];
    for (const [ai, staff] of cases) assertAllNumbersFinite(scoreBoxes(ai, staff));
  });
});

// ---- scorePoints (point categories: wreath, spritzer) ----------------------

describe('scorePoints', () => {
  it('scores a perfect one-to-one match as matched with zero distance and f1 1', () => {
    const boxes: Box[] = [[0.1, 0.1, 0.03, 0.03], [0.5, 0.5, 0.03, 0.03]];
    const s = scorePoints(boxes, boxes);
    expect(s.matchedCount).toBe(2);
    expect(s.unmatchedAiCount).toBe(0);
    expect(s.unmatchedStaffCount).toBe(0);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.meanNearestDistance).toBeCloseTo(0, 10);
    expect(s.medianNearestDistance).toBeCloseTo(0, 10);
    for (const bucket of s.distanceHistogram) expect(bucket.count).toBe(2);
  });

  it('scores a total miss (far apart) as unmatched, and still reports the real distance in the distribution, not null', () => {
    const ai: Box[] = [[0, 0, 0.03, 0.03]];
    const staff: Box[] = [[0.9, 0.9, 0.03, 0.03]];
    const s = scorePoints(ai, staff);
    expect(s.matchedCount).toBe(0);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(1);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.meanNearestDistance).toBeCloseTo(0.9 * Math.SQRT2, 6);
    expect(s.noAiCandidateCount).toBe(0); // there WAS an AI candidate, it was just far away
    for (const bucket of s.distanceHistogram) expect(bucket.count).toBe(0); // 1.27 exceeds every named bucket
  });

  it('scores a partial match: one AI point hits, one is a false positive, one staff point is missed', () => {
    const ai: Box[] = [[0.1, 0.1, 0.03, 0.03], [0.9, 0.9, 0.03, 0.03]];
    const staff: Box[] = [[0.1, 0.1, 0.03, 0.03], [0.5, 0.5, 0.03, 0.03]];
    const s = scorePoints(ai, staff);
    expect(s.matchedCount).toBe(1);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(1);
    expect(s.precision).toBeCloseTo(0.5, 10);
    expect(s.recall).toBeCloseTo(0.5, 10);
  });

  it('does not match two points whose centroid distance exceeds CENTROID_MATCH_THRESHOLD, but the distance still appears in the distribution', () => {
    const ai: Box[] = [[0.1, 0.1, 0.02, 0.02]];
    // centroid-to-centroid distance 0.08 > default threshold 0.05
    const staff: Box[] = [[0.18, 0.1, 0.02, 0.02]];
    const s = scorePoints(ai, staff, CENTROID_MATCH_THRESHOLD);
    expect(s.matchedCount).toBe(0);
    expect(s.meanNearestDistance).toBeCloseTo(0.08, 6);
    // within the wider 0.10 histogram bucket even though it missed the 0.05 match threshold
    const bucket10 = s.distanceHistogram.find((b) => b.threshold === 0.10);
    expect(bucket10?.count).toBe(1);
    const bucket02 = s.distanceHistogram.find((b) => b.threshold === 0.02);
    expect(bucket02?.count).toBe(0);
  });

  it('gives the closer AI point the match when two AI points compete for one staff point, leaving the farther one unmatched', () => {
    const staffBox: Box = [0.5, 0.5, 0.02, 0.02];
    const closeAi: Box = [0.5, 0.5, 0.02, 0.02]; // distance 0
    const farAi: Box = [0.52, 0.5, 0.02, 0.02]; // distance 0.02, still within threshold but loses
    const s = scorePoints([farAi, closeAi], [staffBox]);
    expect(s.matchedCount).toBe(1);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(0);
    // the nearest-neighbor distribution still measures the TRUE nearest (closeAi, distance 0),
    // independent of which one won the one-to-one assignment.
    expect(s.meanNearestDistance).toBeCloseTo(0, 10);
  });

  it('reports a vacuous perfect score when neither side has any points for this category', () => {
    const s = scorePoints([], []);
    expect(s.matchedCount).toBe(0);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.meanNearestDistance).toBeNull();
    expect(s.medianNearestDistance).toBeNull();
    for (const bucket of s.distanceHistogram) expect(bucket.fraction).toBeNull();
  });

  it('reports precision 0 / recall null / f1 0, with no distance distribution, when the AI hallucinates points the staff never placed', () => {
    const s = scorePoints([[0.1, 0.1, 0.02, 0.02], [0.6, 0.6, 0.02, 0.02]], []);
    expect(s.precision).toBe(0);
    expect(s.recall).toBeNull();
    expect(s.f1).toBe(0);
    expect(s.meanNearestDistance).toBeNull(); // no staff point to measure FROM
    expect(s.noAiCandidateCount).toBe(0); // the "no candidate" count is about STAFF points, and there are none
  });

  it('reports recall 0 / precision null / f1 0 and a noAiCandidateCount when the AI placed nothing at all', () => {
    const s = scorePoints([], [[0.1, 0.1, 0.02, 0.02], [0.5, 0.5, 0.02, 0.02]]);
    expect(s.precision).toBeNull();
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.meanNearestDistance).toBeNull();
    expect(s.noAiCandidateCount).toBe(2); // both staff points had zero AI candidates
  });

  it('carries an informational secondary IoU score computed the same way scoreBoxes would', () => {
    const boxes: Box[] = [[0.1, 0.1, 0.03, 0.03]];
    const s = scorePoints(boxes, boxes);
    expect(s.iou.matchedCount).toBe(1);
    expect(s.iou.meanIou).toBeCloseTo(1, 10);
  });

  it('never produces NaN or Infinity in any numeric field, including nested distanceHistogram/iou, across the degenerate cases above', () => {
    const cases: [Box[], Box[]][] = [[[], []], [[[0, 0, 0.02, 0.02]], []], [[], [[0, 0, 0.02, 0.02]]]];
    for (const [ai, staff] of cases) assertAllNumbersFinite(scorePoints(ai, staff));
  });
});

// ---- scorePolylines --------------------------------------------------------

const line = (points: [number, number][]): LineSegment => ({ points, label: 'test' });

describe('scorePolylines', () => {
  it('scores identical polylines as a perfect match: zero distance, ratio 1', () => {
    const lines = [line([[0, 0.5], [1, 0.5]])];
    const s = scorePolylines(lines, lines);
    expect(s.meanForwardDistance).toBeCloseTo(0, 6);
    expect(s.meanBackwardDistance).toBeCloseTo(0, 6);
    expect(s.symmetricChamfer).toBeCloseTo(0, 6);
    expect(s.lengthRatio).toBeCloseTo(1, 6);
  });

  it('scores a total miss (parallel lines far apart) with a distance close to the true separation', () => {
    const ai = [line([[0, 0], [1, 0]])];
    const staff = [line([[0, 0.5], [1, 0.5]])];
    const s = scorePolylines(ai, staff);
    expect(s.meanForwardDistance).toBeCloseTo(0.5, 2);
    expect(s.meanBackwardDistance).toBeCloseTo(0.5, 2);
    expect(s.lengthRatio).toBeCloseTo(1, 6); // same length, wrong place — ratio alone would hide this
  });

  it('scores a partial match: AI line covers half the staff line, so backward distance is larger than forward', () => {
    const ai = [line([[0, 0], [0.5, 0]])];
    const staff = [line([[0, 0], [1, 0]])];
    const s = scorePolylines(ai, staff);
    expect(s.meanForwardDistance).toBeCloseTo(0, 6); // every AI point sits ON the staff line
    expect(s.meanBackwardDistance).toBeGreaterThan(0); // the missing half of the staff line pulls this up
    expect(s.lengthRatio).toBeCloseTo(0.5, 6);
  });

  it('reports a length ratio under 1 and a nonzero distance for a slightly-offset line', () => {
    const ai = [line([[0, 0.01], [1, 0.01]])];
    const staff = [line([[0, 0], [1, 0]])];
    const s = scorePolylines(ai, staff);
    expect(s.meanForwardDistance).toBeCloseTo(0.01, 3);
    expect(s.lengthRatio).toBeCloseTo(1, 6);
  });

  it('reports a vacuous perfect match when neither side drew any line for this category', () => {
    const s = scorePolylines([], []);
    expect(s).toMatchObject({
      aiSegmentCount: 0, staffSegmentCount: 0, aiLengthNorm: 0, staffLengthNorm: 0, lengthRatio: 1,
      meanForwardDistance: 0, meanBackwardDistance: 0, medianForwardDistance: 0, medianBackwardDistance: 0, symmetricChamfer: 0,
    });
  });

  it('leaves distances null (not 0) when the AI drew nothing but staff drew a real line', () => {
    const staff = [line([[0, 0], [1, 0]])];
    const s = scorePolylines([], staff);
    expect(s.aiSegmentCount).toBe(0);
    expect(s.staffSegmentCount).toBe(1);
    expect(s.meanForwardDistance).toBeNull();
    expect(s.meanBackwardDistance).toBeNull();
    expect(s.symmetricChamfer).toBeNull();
    expect(s.lengthRatio).toBe(0); // 0 AI footage / positive staff footage is well-defined
  });

  it('leaves lengthRatio null when staff drew nothing but the AI hallucinated a line', () => {
    const ai = [line([[0, 0], [1, 0]])];
    const s = scorePolylines(ai, []);
    expect(s.lengthRatio).toBeNull(); // dividing by zero staff footage is undefined, not Infinity
    expect(s.meanForwardDistance).toBeNull();
  });

  it('never produces NaN or Infinity across the degenerate cases above', () => {
    const real = [line([[0, 0], [1, 0]])];
    for (const [ai, staff] of [[[], []], [real, []], [[], real]] as [LineSegment[], LineSegment[]][]) {
      assertAllNumbersFinite(scorePolylines(ai, staff));
    }
  });
});

// ---- scoreExample -----------------------------------------------------------

const emptyPieces: DetectionPieces = {
  santasLines: [], gingerbreadLines: [], miniLightDetections: [], wreathDetections: [], spritzerDetections: [], garlandDetections: [],
};

describe('scoreExample', () => {
  it('scores every category independently, including a house with nothing in any category', () => {
    const s = scoreExample(emptyPieces, emptyPieces);
    expect(s.santas.lengthRatio).toBe(1);
    expect(s.wreath.f1).toBe(1);
    expect(s.spritzer.f1).toBe(1);
    expect(s.garland.f1).toBe(1);
    expect(s.mini.f1).toBe(1);
  });

  it('scores wreath/spritzer with scorePoints (distance-based) and garland/mini with scoreBoxes (IoU-based)', () => {
    const ai: DetectionPieces = {
      ...emptyPieces,
      santasLines: [line([[0, 0], [1, 0]])],
      wreathDetections: [{ size: '30noble', tier: 'bow', box: [0.1, 0.1, 0.05, 0.05], label: 'w' }],
    };
    const staff: DetectionPieces = {
      ...emptyPieces,
      santasLines: [line([[0, 0], [1, 0]])],
      wreathDetections: [{ size: '30noble', tier: 'bow', box: [0.1, 0.1, 0.05, 0.05], label: 'w' }],
      spritzerDetections: [{ size: '24', box: [0.5, 0.5, 0.05, 0.05], label: 's' }],
    };
    const s = scoreExample(ai, staff);
    expect(s.santas.symmetricChamfer).toBeCloseTo(0, 6);
    // wreath is a PointScore (has meanNearestDistance) — the identical box is a perfect distance match
    expect(s.wreath.f1).toBe(1);
    expect(s.wreath.meanNearestDistance).toBeCloseTo(0, 10);
    // spritzer: AI has none, staff has one -> a clean miss, not contaminated by the wreath match above
    expect(s.spritzer.recall).toBe(0);
    expect(s.spritzer.precision).toBeNull();
    // garland/mini are BoxScore (IoU-based) and stay vacuously perfect since neither side has any
    expect(s.garland.meanIou).toBeNull();
    expect(s.garland.f1).toBe(1);
    expect(s.mini.f1).toBe(1);
    // gingerbread untouched by either side's santas lines
    expect(s.gingerbread.lengthRatio).toBe(1);
  });
});

// ---- computeSeedAcceptance --------------------------------------------------

function wreathItem(id: string): WreathItem {
  return { id, yardstickId: null, kind: 'wreath', x: 100, y: 100, sizeIn: 30, withLights: true, quoteSize: '30noble', tier: 'bow', included: true };
}
function spritzerItem(id: string): SpritzerItem {
  return { id, yardstickId: null, kind: 'spritzer', x: 100, y: 100, sizeIn: 24, colorPattern: [], included: true };
}
function miniAreaItem(id: string): MiniAreaItem {
  return { id, yardstickId: null, kind: 'miniArea', shape: 'box', x: 0, y: 0, width: 10, height: 10, surface: 'bush', included: true };
}
function garlandItem(id: string): GarlandItem {
  return { id, yardstickId: null, kind: 'garland', points: [0, 0, 10, 0], drawingStyle: 'strand', withLights: true, quoteLength: '9ft', tier: 'bow', included: true };
}
function strandItem(id: string): StrandItem {
  return { id, yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12, drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 10, 0], surface: 'santas-roofline', included: true };
}
const scene = (items: Scene['items']): Scene => ({ yardsticks: [], items });

describe('computeSeedAcceptance', () => {
  it('reports total 0 / seeded 0 / rate null for every category on an empty scene', () => {
    const rates = computeSeedAcceptance(scene([]));
    expect(rates).toHaveLength(4);
    for (const r of rates) expect(r).toMatchObject({ total: 0, seeded: 0, rate: null });
  });

  it('counts an item still carrying its seed- id as seeded, and a staff-redrawn (non seed-) id as not', () => {
    const rates = computeSeedAcceptance(scene([
      wreathItem('seed-wreath-1'),
      wreathItem('a1b2c3'), // staff redrew this one — a real generated id, no seed- prefix
      spritzerItem('seed-spritzer-1'),
      spritzerItem('seed-spritzer-2'),
    ]));
    const wreath = rates.find((r) => r.category === 'wreath')!;
    expect(wreath).toMatchObject({ total: 2, seeded: 1, rate: 0.5 });
    const spritzer = rates.find((r) => r.category === 'spritzer')!;
    expect(spritzer).toMatchObject({ total: 2, seeded: 2, rate: 1 });
  });

  it('counts miniArea and garland independently and ignores unrelated item kinds (e.g. strand)', () => {
    const rates = computeSeedAcceptance(scene([
      miniAreaItem('seed-mini-1'),
      miniAreaItem('m2'),
      miniAreaItem('m3'),
      garlandItem('g1'), // staff-drawn, no seeded garland at all — mirrors the real corpus (0/4 seeded)
      strandItem('s1'), // not one of the four acceptance categories — must not be counted anywhere
    ]));
    const miniArea = rates.find((r) => r.category === 'miniArea')!;
    expect(miniArea).toMatchObject({ total: 3, seeded: 1 });
    expect(miniArea.rate).toBeCloseTo(1 / 3, 10);
    const garland = rates.find((r) => r.category === 'garland')!;
    expect(garland).toMatchObject({ total: 1, seeded: 0, rate: 0 });
  });
});
