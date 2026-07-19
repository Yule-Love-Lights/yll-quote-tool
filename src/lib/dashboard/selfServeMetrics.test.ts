import { describe, it, expect } from 'vitest';
import { computeSelfServeMetrics, isVerified, type SelfServeMetricsRow } from './selfServeMetrics';

// A VERIFIED row by default: staff re-priced (status left 'draft' AND the live
// total moved off the estimate total), and the final landed inside the band.
const row = (over: Partial<SelfServeMetricsRow>): SelfServeMetricsRow => ({
  low: 2200,
  high: 2750,
  total: 2600, // live total (staff-repriced) — inside [2200, 2750]
  estimateTotal: 2480, // raw engine total at estimate time (≠ total ⇒ re-priced)
  status: 'sent',
  ...over,
});

describe('isVerified', () => {
  it('true when staff re-priced (non-draft, priced, total moved off the estimate)', () => {
    expect(isVerified(row({}))).toBe(true);
  });

  it('false while still a draft', () => {
    expect(isVerified(row({ status: 'draft' }))).toBe(false);
  });

  it('false when the total is unchanged from the estimate (a sent-unchanged quote is trivially in-range)', () => {
    expect(isVerified(row({ total: 2480, estimateTotal: 2480 }))).toBe(false);
  });

  it('false when the quote is unpriced or the estimate total is missing', () => {
    expect(isVerified(row({ total: null }))).toBe(false);
    expect(isVerified(row({ estimateTotal: null }))).toBe(false);
  });

  it('true for a re-priced quote even in a terminal status (declined-after-repricing is still evidence)', () => {
    expect(isVerified(row({ status: 'declined', total: 3100 }))).toBe(true);
  });
});

describe('computeSelfServeMetrics', () => {
  it('is all-empty with no estimates', () => {
    expect(computeSelfServeMetrics([])).toEqual({
      totalEstimates: 0,
      verifiedCount: 0,
      inRangeRate: null,
      medianMissPct: null,
    });
  });

  it('counts estimates but leaves accuracy null until a quote is verified (re-priced)', () => {
    const m = computeSelfServeMetrics([
      row({ status: 'draft' }),
      row({ total: 2480, estimateTotal: 2480 }), // sent unchanged — not evidence
    ]);
    expect(m.totalEstimates).toBe(2);
    expect(m.verifiedCount).toBe(0);
    expect(m.inRangeRate).toBeNull();
    expect(m.medianMissPct).toBeNull();
  });

  it('does NOT inflate to 100% when a quote is sent unchanged (the regression this fix targets)', () => {
    // Range built around estimateTotal → the unchanged total is trivially in it.
    const m = computeSelfServeMetrics([row({ status: 'sent', total: 2480, estimateTotal: 2480, low: 2200, high: 2750 })]);
    expect(m.verifiedCount).toBe(0);
    expect(m.inRangeRate).toBeNull();
  });

  it('computes in-range rate over verified rows only: staff final inside vs outside the band', () => {
    const m = computeSelfServeMetrics([
      row({ low: 2000, high: 3000, estimateTotal: 2500, total: 2600 }), // in range
      row({ low: 2000, high: 3000, estimateTotal: 2500, total: 2900 }), // in range
      row({ low: 2000, high: 3000, estimateTotal: 2500, total: 3500 }), // over
      row({ low: 2000, high: 3000, estimateTotal: 2500, total: 1500 }), // under
      row({ status: 'draft' }), // excluded (not verified)
    ]);
    expect(m.verifiedCount).toBe(4);
    expect(m.inRangeRate).toBe(0.5);
  });

  it('median miss = median |final − midpoint| / midpoint over verified rows', () => {
    // midpoints all 2500. misses: 0, 0.2, 0.2
    const m = computeSelfServeMetrics([
      row({ low: 2000, high: 3000, estimateTotal: 2400, total: 2500 }),
      row({ low: 2000, high: 3000, estimateTotal: 2400, total: 3000 }),
      row({ low: 2000, high: 3000, estimateTotal: 2400, total: 2000 }),
    ]);
    expect(m.medianMissPct).toBeCloseTo(0.2, 10);
  });

  it('averages the two middle misses on an even count', () => {
    // midpoints 2500. misses sorted: 0 (2500), 0.08 (2700), 0.2 (3000), 0.4 (3500)
    const m = computeSelfServeMetrics([
      row({ low: 2000, high: 3000, estimateTotal: 2400, total: 2500 }),
      row({ low: 2000, high: 3000, estimateTotal: 2400, total: 2700 }),
      row({ low: 2000, high: 3000, estimateTotal: 2400, total: 3000 }),
      row({ low: 2000, high: 3000, estimateTotal: 2400, total: 3500 }),
    ]);
    expect(m.medianMissPct).toBeCloseTo(0.14, 10);
  });
});
