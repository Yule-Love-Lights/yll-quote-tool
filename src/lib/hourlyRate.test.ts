import { describe, expect, it } from 'vitest';

import { dollarsToCents } from './hourlyRate';

describe('dollarsToCents', () => {
  it('parses whole dollars and cents exactly (integer-cents math, no float drift)', () => {
    expect(dollarsToCents('22')).toBe(2200);
    expect(dollarsToCents('22.50')).toBe(2250);
    expect(dollarsToCents('22.5')).toBe(2250); // one decimal place is padded
    expect(dollarsToCents('0.10')).toBe(10); // the classic 0.1 * 100 float trap
    expect(dollarsToCents('0.01')).toBe(1);
    expect(dollarsToCents('0')).toBe(0); // zero is a valid, deliberate entry
  });

  it('tolerates a leading $ and thousands separators and surrounding space', () => {
    expect(dollarsToCents(' $1,250.00 ')).toBe(125000);
    expect(dollarsToCents('$22.50')).toBe(2250);
  });

  it('rejects blank, non-numeric, negative, and over-precise input', () => {
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('   ')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
    expect(dollarsToCents('1.234')).toBeNull(); // more than two decimal places
    expect(dollarsToCents('.5')).toBeNull(); // needs a whole part
  });

  it('rejects a non-string and anything above the typo-guard cap', () => {
    expect(dollarsToCents(2250 as unknown)).toBeNull();
    expect(dollarsToCents(null as unknown)).toBeNull();
    expect(dollarsToCents('10000.01')).toBeNull(); // $10,000.01 > cap
    expect(dollarsToCents('10000')).toBe(1000000); // exactly the cap is allowed
  });
});
