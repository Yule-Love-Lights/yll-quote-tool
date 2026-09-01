import { describe, it, expect } from 'vitest';
import { buildSelfServeSeed, buildSelfServeSatelliteLines } from './design';
import type { PhotoAnalysisResult } from '@/lib/photoAnalysis';

// The seed mapping is what makes a self-serve quote openable as a DRAWING: get
// it wrong and the quote shows footage with no traced roofline behind it, which
// is exactly the gap this module exists to close.

function makeResult(over: Partial<PhotoAnalysisResult> = {}): PhotoAnalysisResult {
  return {
    santasFootage: 40,
    santasDifficulty: 'easy',
    santasLines: [{ points: [[0.1, 0.5], [0.9, 0.5]], label: 'front gutter ~40ft' }],
    gingerbreadFootage: 65,
    gingerbreadDifficulty: 'easy',
    gingerbreadLines: [{ points: [[0.2, 0.3], [0.8, 0.3]], label: 'ridge ~65ft' }],
    satelliteSantasLines: [{ points: [[0.15, 0.55], [0.85, 0.55]], label: 'sat front' }],
    satelliteSantasFootage: 42,
    satelliteGingerbreadLines: [{ points: [[0.25, 0.35], [0.75, 0.35]], label: 'sat ridge' }],
    satelliteGingerbreadFootage: 67,
    computedSatelliteSantasFootage: null,
    computedSatelliteGingerbreadFootage: null,
    satelliteSantasFootageDisagrees: false,
    satelliteGingerbreadFootageDisagrees: false,
    doorAnchorFtPerPx: null,
    doorAnchorSource: null,
    doorAnchorConfidence: null,
    preferredSource: 'street',
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    garlandDetections: [],
    notes: '',
    confidence: 'high',
    ...over,
  };
}

describe('buildSelfServeSeed', () => {
  it('carries the traced street polylines through as roofline seed lines', () => {
    const seed = buildSelfServeSeed(makeResult());
    expect(seed.lines?.santas).toEqual([[[0.1, 0.5], [0.9, 0.5]]]);
    expect(seed.lines?.gingerbread).toEqual([[[0.2, 0.3], [0.8, 0.3]]]);
  });

  it('passes the AI footage as calibration so the scale yardstick is seeded', () => {
    // Lines + footage together give pixels-per-foot — without calibration the
    // design opens with no scale and garland/per-unit seeding degrades.
    const seed = buildSelfServeSeed(makeResult());
    expect(seed.calibration).toEqual({ santasFootage: 40, gingerbreadFootage: 65 });
  });

  it('carries per-unit detections through', () => {
    const seed = buildSelfServeSeed(
      makeResult({
        wreathDetections: [{ box: [0.4, 0.4, 0.5, 0.5], label: 'wreath' }] as PhotoAnalysisResult['wreathDetections'],
      }),
    );
    expect(seed.detections?.wreaths).toHaveLength(1);
  });

  it('produces empty line arrays (not undefined) when the analyzer traced nothing', () => {
    const seed = buildSelfServeSeed(makeResult({ santasLines: [], gingerbreadLines: [] }));
    expect(seed.lines?.santas).toEqual([]);
    expect(seed.lines?.gingerbread).toEqual([]);
  });
});

describe('buildSelfServeSatelliteLines', () => {
  it('maps satellite polylines with their labels into the design shape', () => {
    const sat = buildSelfServeSatelliteLines(makeResult());
    expect(sat.santas).toEqual([{ points: [[0.15, 0.55], [0.85, 0.55]], label: 'sat front' }]);
    expect(sat.gingerbread).toEqual([{ points: [[0.25, 0.35], [0.75, 0.35]], label: 'sat ridge' }]);
    expect(sat.c9).toEqual([]);
  });
});
