import { describe, expect, it } from 'vitest';
import { classifyRow, mean, num, parseFtPerPx, stdev, str } from './door-anchor-report-core';

describe('parseFtPerPx', () => {
  it('treats a JSON null (the normal "door anchor not found" value) as not present', () => {
    expect(parseFtPerPx(null)).toBeNull();
  });

  it('treats undefined as not present', () => {
    expect(parseFtPerPx(undefined)).toBeNull();
  });

  it('treats zero as not present (a meaningless ft/px scale)', () => {
    expect(parseFtPerPx(0)).toBeNull();
  });

  it('treats a negative number as not present', () => {
    expect(parseFtPerPx(-0.01)).toBeNull();
  });

  it('treats a non-numeric value as not present', () => {
    expect(parseFtPerPx('not-a-number')).toBeNull();
  });

  it('parses a genuine positive scale', () => {
    expect(parseFtPerPx(0.0123)).toBeCloseTo(0.0123);
  });
});

describe('num', () => {
  it('preserves 0 as a legitimate value (e.g. doorAnchorConfidence)', () => {
    expect(num(0)).toBe(0);
  });

  it('num(null) is 0, by design -- num() is only used for fields where 0 is a valid value; the ft/px scale fields use parseFtPerPx instead, precisely because 0 is NOT valid there', () => {
    expect(num(null)).toBe(0);
  });
});

describe('str', () => {
  it('passes through a string', () => {
    expect(str('satellite')).toBe('satellite');
  });

  it('returns null for a non-string', () => {
    expect(str(null)).toBeNull();
    expect(str(42)).toBeNull();
  });
});

describe('mean / stdev', () => {
  it('mean of an empty array is null', () => {
    expect(mean([])).toBeNull();
  });

  it('stdev needs at least 2 points', () => {
    expect(stdev([5])).toBeNull();
    expect(stdev([])).toBeNull();
  });

  it('computes mean and stdev correctly', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(stdev([1, 2, 3])).toBeCloseTo(Math.sqrt(2 / 3));
  });
});

describe('classifyRow', () => {
  it('buckets a row with no seed_analysis at all', () => {
    const result = classifyRow({ hasAnalysis: false, doorAnchorFtPerPx: null, yardstickFtPerPx: 0.02 });
    expect(result.bucket).toBe('no_seed_analysis');
    expect(result.ratio).toBeNull();
    expect(result.pctDisagree).toBeNull();
  });

  it('buckets a row where the door anchor scale is null (not present) as no_door_anchor -- NOT comparable', () => {
    // This is the F1 regression case: doorAnchorFtPerPx must already be parsed via
    // parseFtPerPx (which turns JSON null into null, not 0) before reaching classifyRow.
    const result = classifyRow({ hasAnalysis: true, doorAnchorFtPerPx: null, yardstickFtPerPx: 0.02 });
    expect(result.bucket).toBe('no_door_anchor');
    expect(result.ratio).toBeNull();
    expect(result.pctDisagree).toBeNull();
  });

  it('buckets a row with no yardstick as no_yardstick', () => {
    const result = classifyRow({ hasAnalysis: true, doorAnchorFtPerPx: 0.02, yardstickFtPerPx: null });
    expect(result.bucket).toBe('no_yardstick');
    expect(result.ratio).toBeNull();
    expect(result.pctDisagree).toBeNull();
  });

  it('buckets a genuine pair as comparable and computes the correct disagreement %', () => {
    // door-anchor 0.022 ft/px vs yardstick 0.02 ft/px -> ratio 1.1, 10% disagreement.
    const result = classifyRow({ hasAnalysis: true, doorAnchorFtPerPx: 0.022, yardstickFtPerPx: 0.02 });
    expect(result.bucket).toBe('comparable');
    expect(result.ratio).toBeCloseTo(1.1);
    expect(result.pctDisagree).toBeCloseTo(0.1);
  });
});
