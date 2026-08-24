import { describe, it, expect } from 'vitest';
import {
  iou,
  centroidDistance,
  scoreBoxes,
  scorePolylines,
  scoreExample,
  IOU_MATCH_THRESHOLD,
  type Box,
  type DetectionPieces,
} from './placementEval';
import type { LineSegment } from '@/lib/photoAnalysis';

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

// ---- scoreBoxes -----------------------------------------------------------

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

  it('scores a total miss (no box anywhere near another) as all unmatched', () => {
    const ai: Box[] = [[0, 0, 0.05, 0.05]];
    const staff: Box[] = [[0.9, 0.9, 0.05, 0.05]];
    const s = scoreBoxes(ai, staff);
    expect(s.matchedCount).toBe(0);
    expect(s.unmatchedAiCount).toBe(1);
    expect(s.unmatchedStaffCount).toBe(1);
    expect(s.meanIou).toBeNull();
    expect(s.meanCentroidDistance).toBeNull();
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
  });

  it('reports recall 0 / precision null / f1 0 when the AI misses every staff-placed box', () => {
    const s = scoreBoxes([], [[0.1, 0.1, 0.1, 0.1]]);
    expect(s.aiCount).toBe(0);
    expect(s.staffCount).toBe(1);
    expect(s.matchedCount).toBe(0);
    expect(s.precision).toBeNull();
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
  });

  it('never produces NaN or Infinity in any numeric field across the degenerate cases above', () => {
    const cases: [Box[], Box[]][] = [[[], []], [[[0, 0, 0.1, 0.1]], []], [[], [[0, 0, 0.1, 0.1]]]];
    for (const [ai, staff] of cases) {
      const s = scoreBoxes(ai, staff);
      for (const v of Object.values(s)) {
        if (typeof v === 'number') {
          expect(Number.isNaN(v)).toBe(false);
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
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
      const s = scorePolylines(ai, staff);
      for (const v of Object.values(s)) {
        if (typeof v === 'number') {
          expect(Number.isNaN(v)).toBe(false);
          expect(Number.isFinite(v)).toBe(true);
        }
      }
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

  it('reads .box off wreath/spritzer/garland/mini detections and .points off line detections independently per category', () => {
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
    expect(s.wreath.f1).toBe(1);
    // spritzer: AI has none, staff has one -> a clean miss, not contaminated by the wreath match above
    expect(s.spritzer.recall).toBe(0);
    expect(s.spritzer.precision).toBeNull();
    // gingerbread untouched by either side's santas lines
    expect(s.gingerbread.lengthRatio).toBe(1);
  });
});
