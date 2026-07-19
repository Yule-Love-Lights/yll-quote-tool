// #110 W1-064 — locks the TWO deliberately-different round-to-cents variants so
// the shared helper can never silently converge them (that would change money
// rounding at the call sites that switched to it).

import { describe, it, expect } from 'vitest';
import { moneyTimesRate, roundMoney, roundMoneyGuarded } from './money';

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


describe('moneyTimesRate', () => {
  it('rounds an exact half-cent up after decimal rate multiplication', () => {
    expect(moneyTimesRate(1002.8, 0.0875)).toBe(87.75);
  });

  it('keeps ordinary below-half and above-half results unchanged', () => {
    expect(moneyTimesRate(1000, 0.0875)).toBe(87.5);
    expect(moneyTimesRate(850, 0.0875)).toBe(74.38);
  });
});
