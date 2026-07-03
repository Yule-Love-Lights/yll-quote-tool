// #110 W1-064 — locks the TWO deliberately-different round-to-cents variants so
// the shared helper can never silently converge them (that would change money
// rounding at the call sites that switched to it).

import { describe, it, expect } from 'vitest';
import { roundMoney, roundMoneyGuarded } from './money';

describe('roundMoneyGuarded (invoice/amend/balance variant)', () => {
  it('rounds to cents', () => {
    expect(roundMoneyGuarded(12.345)).toBe(12.35);
    expect(roundMoneyGuarded(12.344)).toBe(12.34);
    expect(roundMoneyGuarded(100)).toBe(100);
  });

  it('coerces a non-finite input to 0 (never writes NaN into a balance)', () => {
    expect(roundMoneyGuarded(NaN)).toBe(0);
    expect(roundMoneyGuarded(Infinity)).toBe(0);
    expect(roundMoneyGuarded(-Infinity)).toBe(0);
  });

  it('EPSILON-nudges a value on the half-cent boundary up predictably', () => {
    // 1.005 * 100 is 100.49999… in float; the EPSILON nudge rounds it to 1.01.
    expect(roundMoneyGuarded(1.005)).toBe(1.01);
  });
});

describe('roundMoney (portal/approve variant)', () => {
  it('rounds to cents', () => {
    expect(roundMoney(12.345)).toBe(12.35);
    expect(roundMoney(12.344)).toBe(12.34);
  });

  it('does NOT guard non-finite inputs (call sites validate upstream)', () => {
    expect(roundMoney(NaN)).toBeNaN();
    expect(roundMoney(Infinity)).toBe(Infinity);
  });
});
