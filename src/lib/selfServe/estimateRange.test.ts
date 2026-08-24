import { describe, it, expect } from 'vitest';
import { computeEstimateRange, customerEstimateRange, analysisToHolidayInputs, isMeasurable } from './estimateRange';
import type { PhotoAnalysisResult } from '@/lib/photoAnalysis';

// The self-serve estimate shows the customer a RANGE, never a single binding
// number (Phase A). The range is money the customer anchors on, so its math is
// tested first: rounding direction, margin symmetry, and the guard against a
// non-positive engine total (which must throw, never render "$0 – $0").

describe('computeEstimateRange', () => {
  it('brackets the total with a symmetric margin, low rounded down / high rounded up to $50', () => {
    // total 2480, ±10% → 2232..2728 → rounded to 2200..2750
    const { low, high } = computeEstimateRange(2480, 0.1);
    expect(low).toBe(2200);
    expect(high).toBe(2750);
    expect(low).toBeLessThan(high);
  });

  it('keeps low strictly below high even at the engine minimum ($1000)', () => {
    const { low, high } = computeEstimateRange(1000, 0.1);
    expect(low).toBe(900);
    expect(high).toBe(1100);
  });

  it('defaults to a 10% margin when none is passed', () => {
    expect(computeEstimateRange(2480)).toEqual(computeEstimateRange(2480, 0.1));
  });

  it('never emits a negative low', () => {
    const { low } = computeEstimateRange(1000, 0.99);
    expect(low).toBeGreaterThanOrEqual(0);
  });

  it('throws on a non-positive or non-finite total (money math must not render garbage)', () => {
    expect(() => computeEstimateRange(0)).toThrow();
    expect(() => computeEstimateRange(-500)).toThrow();
    expect(() => computeEstimateRange(Number.NaN)).toThrow();
    expect(() => computeEstimateRange(Number.POSITIVE_INFINITY)).toThrow();
  });
});

// customerEstimateRange is what the customer actually sees: the margin bracket
// composed with the $1,000 job minimum. The S47 LOW: computeEstimateRange's -10%
// margin dropped a min-floored total ($1,000) to a $900 low the customer can
// never be charged. These lock in that the shown low never dips below the minimum.
describe('customerEstimateRange', () => {
  const MIN = 1000;

  it('never shows a low below the job minimum, even for a home priced under it', () => {
    // Raw margin on a $1,000 total would be 900–1100; the shown low must be $1,000.
    const { low, high } = customerEstimateRange(700, MIN);
    expect(low).toBe(1000);
    expect(high).toBe(1100);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(MIN);
  });

  it('floors the low at the minimum for a total exactly at the minimum (the S47 LOW)', () => {
    const { low, high } = customerEstimateRange(1000, MIN);
    expect(low).toBe(1000); // was 900 before the fix
    expect(high).toBe(1100);
  });

  it('leaves a comfortably-above-minimum total unchanged (no over-clamping)', () => {
    // total 2480 → 2200–2750, both clear of the minimum → identical to raw.
    const { low, high } = customerEstimateRange(2480, MIN);
    expect(low).toBe(2200);
    expect(high).toBe(2750);
  });

  it('keeps low strictly below high across the boundary', () => {
    for (const total of [500, 900, 1000, 1050, 1200, 5000]) {
      const { low, high } = customerEstimateRange(total, MIN);
      expect(low).toBeGreaterThanOrEqual(MIN);
      expect(low).toBeLessThan(high);
    }
  });
});

// A bare analyzer result with a given roofline footage. Only the fields the
// mapping reads are set; the rest are typed placeholders.
function makeResult(over: Partial<PhotoAnalysisResult> = {}): PhotoAnalysisResult {
  return {
    santasFootage: 120,
    santasDifficulty: 'medium',
    santasLines: [],
    gingerbreadFootage: 200,
    gingerbreadDifficulty: 'hard',
    gingerbreadLines: [],
    satelliteSantasLines: [],
    satelliteSantasFootage: 0,
    satelliteGingerbreadLines: [],
    satelliteGingerbreadFootage: 0,
    computedSatelliteSantasFootage: null,
    computedSatelliteGingerbreadFootage: null,
    satelliteSantasFootageDisagrees: false,
    satelliteGingerbreadFootageDisagrees: false,
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

describe('analysisToHolidayInputs', () => {
  it('maps street footage + difficulties and zeroes everything else', () => {
    const inputs = analysisToHolidayInputs(makeResult());
    expect(inputs.santasFootage).toBe(120);
    expect(inputs.santasDifficulty).toBe('medium');
    expect(inputs.gingerbreadFootage).toBe(200);
    expect(inputs.gingerbreadDifficulty).toBe('hard');
    expect(inputs.winterWonderlandFootage).toBe(0);
    expect(inputs.stakeLightingFootage).toBe(0);
    expect(inputs.miniLightItems).toEqual([]);
    expect(inputs.spritzers).toEqual([]);
    expect(inputs.wreaths).toEqual([]);
    expect(inputs.garland).toEqual([]);
    expect(inputs.takedown).toBe('included');
    expect(inputs.rushFee).toBe(false);
  });

  it('prefers satellite footage when the analyzer chose satellite and it is present', () => {
    const inputs = analysisToHolidayInputs(
      makeResult({
        preferredSource: 'satellite',
        satelliteSantasFootage: 140,
        satelliteGingerbreadFootage: 230,
      }),
    );
    expect(inputs.santasFootage).toBe(140);
    expect(inputs.gingerbreadFootage).toBe(230);
  });

  it('falls back to street footage when satellite is preferred but zero', () => {
    const inputs = analysisToHolidayInputs(
      makeResult({ preferredSource: 'satellite', satelliteSantasFootage: 0, satelliteGingerbreadFootage: 0 }),
    );
    expect(inputs.santasFootage).toBe(120);
    expect(inputs.gingerbreadFootage).toBe(200);
  });

  it('falls back to satellite footage when street is preferred but zero (no $0 collapse)', () => {
    const inputs = analysisToHolidayInputs(
      makeResult({
        preferredSource: 'street',
        santasFootage: 0,
        gingerbreadFootage: 0,
        satelliteSantasFootage: 55,
        satelliteGingerbreadFootage: 90,
      }),
    );
    expect(inputs.santasFootage).toBe(55);
    expect(inputs.gingerbreadFootage).toBe(90);
  });
});

describe('isMeasurable', () => {
  it('true for a confident result with roofline footage', () => {
    expect(isMeasurable(makeResult())).toBe(true);
  });

  it('false when the analyzer is not confident', () => {
    expect(isMeasurable(makeResult({ confidence: 'low' }))).toBe(false);
  });

  it('false when there is no roofline footage on either source', () => {
    expect(
      isMeasurable(
        makeResult({
          santasFootage: 0,
          gingerbreadFootage: 0,
          satelliteSantasFootage: 0,
          satelliteGingerbreadFootage: 0,
        }),
      ),
    ).toBe(false);
  });

  it('false for a null result (analyzer outage)', () => {
    expect(isMeasurable(null)).toBe(false);
  });

  it('true for a satellite-only house even when street is preferred (agrees with the mapping)', () => {
    // Regression: isMeasurable must not pass a house that the mapping would then
    // price to $0 — both derive from effectiveRooflineFootage now.
    expect(
      isMeasurable(
        makeResult({
          preferredSource: 'street',
          santasFootage: 0,
          gingerbreadFootage: 0,
          satelliteSantasFootage: 55,
          satelliteGingerbreadFootage: 0,
        }),
      ),
    ).toBe(true);
  });
});
