import { describe, it, expect } from 'vitest';
import { resolveDailyCap, isWithinBudget, DEFAULT_DAILY_ANALYZER_CAP } from './budget';

// The daily budget cap is the ONLY thing bounding the total bill on a public,
// money-spending endpoint (per-IP limiting bounds one attacker's rate, not the
// aggregate). Its decision logic is money-adjacent, so it's pinned first.

describe('resolveDailyCap', () => {
  it('defaults when the env var is missing or blank', () => {
    expect(resolveDailyCap(undefined)).toBe(DEFAULT_DAILY_ANALYZER_CAP);
    expect(resolveDailyCap('')).toBe(DEFAULT_DAILY_ANALYZER_CAP);
    expect(resolveDailyCap('   ')).toBe(DEFAULT_DAILY_ANALYZER_CAP);
  });

  it('accepts a positive integer override', () => {
    expect(resolveDailyCap('500')).toBe(500);
    expect(resolveDailyCap(' 1000 ')).toBe(1000);
    expect(resolveDailyCap('1')).toBe(1);
  });

  it('ignores garbage / non-positive / non-integer and falls back to the default', () => {
    for (const bad of ['abc', '0', '-5', '10.5', 'NaN']) {
      expect(resolveDailyCap(bad), bad).toBe(DEFAULT_DAILY_ANALYZER_CAP);
    }
  });

  it('accepts exponent notation that resolves to a positive integer (1e3 → 1000)', () => {
    expect(resolveDailyCap('1e3')).toBe(1000);
  });
});

describe('isWithinBudget', () => {
  it('allows counts up to AND including the cap (the Nth call still runs)', () => {
    expect(isWithinBudget(1, 300)).toBe(true);
    expect(isWithinBudget(300, 300)).toBe(true);
  });

  it('denies once the post-increment count exceeds the cap', () => {
    expect(isWithinBudget(301, 300)).toBe(false);
    expect(isWithinBudget(9999, 300)).toBe(false);
  });

  it('fails OPEN on an unknown count (null) — the per-IP limit still applies, and a DB blip must not take down the feature', () => {
    expect(isWithinBudget(null, 300)).toBe(true);
  });
});
