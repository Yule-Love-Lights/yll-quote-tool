import { describe, expect, it } from 'vitest';
import {
  dollars,
  isSettlementMethod,
  parseAmountCents,
  referenceCentsFor,
  summarize,
  SETTLEMENT_METHODS,
  type ShiftSettlement,
} from './shiftSettlements';

describe('referenceCentsFor', () => {
  it('converts seconds at an hourly rate to whole cents, nearest', () => {
    expect(referenceCentsFor(3600, 2500)).toBe(2500);
    expect(referenceCentsFor(1800, 2500)).toBe(1250);
    // The real case from prod on 2026-09-02: 50h 55m at $25.00/hr.
    expect(referenceCentsFor(183300, 2500)).toBe(127292);
  });

  it('rounds a half cent to the nearest, not always down', () => {
    // 1 second at $18.00/hr is exactly 0.5 cents.
    expect(referenceCentsFor(1, 1800)).toBe(1);
    // 1 second at $10.00/hr is 0.277… cents.
    expect(referenceCentsFor(1, 1000)).toBe(0);
  });

  it('is zero for nothing worked, no rate, or a nonsense input', () => {
    expect(referenceCentsFor(0, 2500)).toBe(0);
    expect(referenceCentsFor(3600, 0)).toBe(0);
    expect(referenceCentsFor(-3600, 2500)).toBe(0);
    expect(referenceCentsFor(3600, -2500)).toBe(0);
    expect(referenceCentsFor(Number.NaN, 2500)).toBe(0);
    expect(referenceCentsFor(3600, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('never returns a fraction of a cent, at any input', () => {
    for (const seconds of [1, 59, 61, 3599, 3601, 12345, 183300]) {
      for (const rate of [900, 1600, 1700, 2000, 2500]) {
        expect(Number.isInteger(referenceCentsFor(seconds, rate))).toBe(true);
      }
    }
  });
});

describe('parseAmountCents', () => {
  it('reads what a person actually types into a money field', () => {
    expect(parseAmountCents('1350')).toBe(135000);
    expect(parseAmountCents('1350.00')).toBe(135000);
    expect(parseAmountCents('1,350.00')).toBe(135000);
    expect(parseAmountCents('$1,350.00')).toBe(135000);
    expect(parseAmountCents('  1350.5 ')).toBe(135050);
    expect(parseAmountCents('0.01')).toBe(1);
  });

  it('refuses anything that is not a payment', () => {
    for (const junk of ['', '   ', '0', '0.00', '-50', 'abc', '12.345', '1.2.3', '1e3', '$']) {
      expect(parseAmountCents(junk), junk).toBeNull();
    }
  });

  it('refuses a figure finer than a cent rather than rounding somebody pay', () => {
    // Silently turning 1350.005 into 1350.01 would be this function deciding
    // what a payment was; it is a typo and the admin should see it as one.
    expect(parseAmountCents('1350.005')).toBeNull();
  });
});

describe('isSettlementMethod', () => {
  it('accepts exactly the four ways money moves here', () => {
    expect([...SETTLEMENT_METHODS]).toEqual(['cash', 'venmo', 'check', 'other']);
    for (const m of SETTLEMENT_METHODS) expect(isSettlementMethod(m)).toBe(true);
    for (const junk of ['Cash', 'zelle', '', null, undefined, 1]) {
      expect(isSettlementMethod(junk)).toBe(false);
    }
  });
});

describe('dollars', () => {
  it('always shows two decimal places', () => {
    expect(dollars(0)).toBe('$0.00');
    expect(dollars(5)).toBe('$0.05');
    expect(dollars(135000)).toBe('$1350.00');
    expect(dollars(-2500)).toBe('-$25.00');
  });
});

function settlement(over: Partial<ShiftSettlement> & { id: string }): ShiftSettlement {
  return {
    crewMemberId: 'p',
    totalCents: 10000,
    method: 'cash',
    note: null,
    paidAt: '2026-09-01T12:00:00Z',
    paidBy: 'Jason (jason@x)',
    createdAt: '2026-09-01T12:00:00Z',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    lines: [],
    coveredSeconds: 0,
    referenceCents: 0,
    ...over,
  };
}

describe('summarize', () => {
  it('adds up what was actually handed over', () => {
    const out = summarize([
      settlement({ id: 'a', totalCents: 135000, paidAt: '2026-09-01T12:00:00Z' }),
      settlement({ id: 'b', totalCents: 20000, paidAt: '2026-08-20T12:00:00Z' }),
    ]);
    expect(out.settledCents).toBe(155000);
    expect(out.settlementCount).toBe(2);
    expect(out.lastPaidAt).toBe('2026-09-01T12:00:00Z');
  });

  it('counts a VOIDED payment for nothing, which is what undoing one means', () => {
    const out = summarize([
      settlement({ id: 'a', totalCents: 135000 }),
      settlement({ id: 'b', totalCents: 99900, voidedAt: '2026-09-02T09:00:00Z' }),
    ]);
    expect(out.settledCents).toBe(135000);
    expect(out.settlementCount).toBe(1);
  });

  it('takes the latest LIVE payment date, not the latest of any', () => {
    const out = summarize([
      settlement({ id: 'newer-but-void', paidAt: '2026-09-02T12:00:00Z', voidedAt: '2026-09-02T13:00:00Z' }),
      settlement({ id: 'live', paidAt: '2026-08-01T12:00:00Z' }),
    ]);
    expect(out.lastPaidAt).toBe('2026-08-01T12:00:00Z');
  });

  it('is zero, not null-ish, for somebody never paid', () => {
    const out = summarize([]);
    expect(out).toEqual({ settledCents: 0, settlementCount: 0, lastPaidAt: null });
  });
});
