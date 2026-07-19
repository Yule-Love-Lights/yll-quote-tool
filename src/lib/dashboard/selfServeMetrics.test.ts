import { describe, it, expect } from 'vitest';
import { computeSelfServeMetrics, type SelfServeMetricsRow } from './selfServeMetrics';

const row = (over: Partial<SelfServeMetricsRow>): SelfServeMetricsRow => ({
  low: 2000,
  high: 3000,
  total: 2500,
  reviewed: true,
  ...over,
});

describe('computeSelfServeMetrics', () => {
  it('is all-empty with no estimates', () => {
    expect(computeSelfServeMetrics([])).toEqual({
      totalEstimates: 0,
      reviewedCount: 0,
      inRangeRate: null,
      medianMissPct: null,
    });
  });

  it('counts estimates but leaves accuracy null until quotes are reviewed', () => {
    const m = computeSelfServeMetrics([row({ reviewed: false }), row({ reviewed: false })]);
    expect(m.totalEstimates).toBe(2);
    expect(m.reviewedCount).toBe(0);
    expect(m.inRangeRate).toBeNull();
    expect(m.medianMissPct).toBeNull();
  });

  it('ignores reviewed rows with no priced total', () => {
    const m = computeSelfServeMetrics([row({ reviewed: true, total: null })]);
    expect(m.totalEstimates).toBe(1);
    expect(m.reviewedCount).toBe(0);
  });

  it('computes in-range rate: final inside vs outside the shown band', () => {
    const m = computeSelfServeMetrics([
      row({ low: 2000, high: 3000, total: 2500 }), // in range
      row({ low: 2000, high: 3000, total: 2900 }), // in range
      row({ low: 2000, high: 3000, total: 3500 }), // over
      row({ low: 2000, high: 3000, total: 1500 }), // under
    ]);
    expect(m.reviewedCount).toBe(4);
    expect(m.inRangeRate).toBe(0.5);
  });

  it('median miss = median |final − midpoint| / midpoint', () => {
    // midpoints all 2500. misses: |2500-2500|/2500=0, |3000-2500|/2500=0.2, |2000-2500|/2500=0.2
    const m = computeSelfServeMetrics([
      row({ total: 2500 }),
      row({ total: 3000 }),
      row({ total: 2000 }),
    ]);
    expect(m.medianMissPct).toBeCloseTo(0.2, 10);
  });

  it('averages the two middle misses on an even count', () => {
    // midpoints 2500. misses sorted: 0 (2500), 0.08 (2700), 0.2 (3000), 0.4 (3500)
    const m = computeSelfServeMetrics([
      row({ total: 2500 }),
      row({ total: 2700 }),
      row({ total: 3000 }),
      row({ total: 3500 }),
    ]);
    // median of [0, 0.08, 0.2, 0.4] = (0.08 + 0.2) / 2 = 0.14
    expect(m.medianMissPct).toBeCloseTo(0.14, 10);
  });
});
