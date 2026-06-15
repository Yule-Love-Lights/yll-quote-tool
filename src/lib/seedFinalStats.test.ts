import { describe, it, expect } from 'vitest';
import {
  computeBiasSummary,
  formatBiasNote,
  MIN_STATS_PAIRS,
  type SeedFinalPair,
  type BiasSummary,
} from './seedFinalStats';
import type { SeedFinalFinal } from './seedFinalDiff';
import type { MiniLightDetection } from './photoAnalysis';

function mini(stringCount: number): MiniLightDetection {
  return { type: 'bush', wrapStyle: 'canopy', stringCount, box: [0, 0, 0.1, 0.1], label: 'bush' };
}

function finalOf(o: Partial<SeedFinalFinal> = {}): SeedFinalFinal {
  return {
    santasFootage: 0,
    gingerbreadFootage: 0,
    santasDifficulty: 'medium',
    gingerbreadDifficulty: 'medium',
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    garlandDetections: [],
    ...o,
  };
}

// A pair where the AI seed under-measured by a fixed amount.
function underPair(): SeedFinalPair {
  return {
    seed: { santasFootage: 40, miniLightDetections: [mini(2)] }, // 1 item, 2 strings
    final: finalOf({ santasFootage: 55, miniLightDetections: [mini(3), mini(4)] }), // 2 items, 7 strings
  };
}

describe('computeBiasSummary', () => {
  it('returns null below MIN_STATS_PAIRS seeded pairs', () => {
    const pairs = Array.from({ length: MIN_STATS_PAIRS - 1 }, underPair);
    expect(computeBiasSummary(pairs)).toBeNull();
  });

  it('ignores pairs without a seed when counting toward the minimum', () => {
    const seeded = Array.from({ length: MIN_STATS_PAIRS - 1 }, underPair);
    const unseeded: SeedFinalPair = { seed: null, final: finalOf() };
    // (MIN-1) seeded + several unseeded → still below the minimum → null
    expect(computeBiasSummary([...seeded, unseeded, unseeded, unseeded])).toBeNull();
  });

  it('computes the mean signed delta (final - seed) per metric', () => {
    const pairs = Array.from({ length: MIN_STATS_PAIRS }, underPair);
    const summary = computeBiasSummary(pairs)!;
    expect(summary).not.toBeNull();
    expect(summary.n).toBe(MIN_STATS_PAIRS);
    expect(summary.deltas.santasFootage).toBeCloseTo(15); // 55 - 40
    expect(summary.deltas.miniItems).toBeCloseTo(1); // 2 - 1
    expect(summary.deltas.miniStrings).toBeCloseTo(5); // 7 - 2
  });
});

describe('formatBiasNote', () => {
  it('returns null for a null summary', () => {
    expect(formatBiasNote(null)).toBeNull();
  });

  it('phrases footage bias direction-aware (under vs over)', () => {
    const note = formatBiasNote({
      n: 10,
      deltas: { santasFootage: 12, gingerbreadFootage: -8, miniItems: 0, miniStrings: 0, wreaths: 0, spritzers: 0, garland: 0 },
    });
    expect(note).toContain("UNDER-measure front (Santa's) roofline by ~12ft");
    expect(note).toContain('OVER-measure ridge+sides (Gingerbread) roofline by ~8ft');
    expect(note).toContain('based on 10 of this company');
  });

  it('phrases count bias as MISS (positive) vs OVER-suggest (negative)', () => {
    const note = formatBiasNote({
      n: 8,
      deltas: { santasFootage: 0, gingerbreadFootage: 0, miniItems: 1.5, miniStrings: 4, wreaths: -1, spritzers: 0, garland: 0 },
    });
    expect(note).toContain('MISS ~1.5 mini-light items');
    expect(note).toContain('OVER-suggest ~1.0 wreath placements');
    expect(note).toContain('STRING counts run ~4.0 low');
  });

  it('omits metrics within the noise threshold', () => {
    const note = formatBiasNote({
      n: 8,
      deltas: { santasFootage: 1, gingerbreadFootage: 0, miniItems: 0.2, miniStrings: 0.5, wreaths: 0, spritzers: 0, garland: 0 },
    });
    expect(note).toBeNull(); // every delta below its threshold → no note
  });

  it('end-to-end: a seeded corpus produces a calibration block', () => {
    const summary = computeBiasSummary(Array.from({ length: MIN_STATS_PAIRS }, underPair)) as BiasSummary;
    const note = formatBiasNote(summary);
    expect(note).toContain('CALIBRATION FROM YOUR PAST WORK');
    expect(note).toContain("UNDER-measure front (Santa's) roofline by ~15ft");
    expect(note).toContain('MISS ~1.0 mini-light items');
    expect(note).toContain('STRING counts run ~5.0 low');
  });
});
