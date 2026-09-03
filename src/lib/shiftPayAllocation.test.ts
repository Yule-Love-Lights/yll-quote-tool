// Spending a payment across unpaid hours, oldest first, with the remainder
// rolling over — Jason's rule, 2026-09-03.
//
// The case that produced it is the first test below and is real: $180.00 was
// paid to Khaye at $9.00/h for the five weekdays 24–28 Aug, which come to
// 20h 34m. The money buys exactly 20h, so 34 minutes must be left owing
// rather than written off by a payment that did not cover it.

import { describe, expect, it } from 'vitest';

import { allocatePayment, secondsBoughtBy, type PayableRemainder } from './shiftSettlements';

const H = 3600;
const RATE = 900; // $9.00/hour, Khaye's real rate

/** Oldest first, the order allocatePayment consumes in. */
function shifts(...secs: number[]): PayableRemainder[] {
  return secs.map((s, i) => ({
    shiftId: `shift-${i + 1}`,
    clockInAt: `2026-08-${String(24 + i).padStart(2, '0')}T13:00:00.000Z`,
    totalSeconds: s,
    unpaidSeconds: s,
  }));
}

describe('secondsBoughtBy', () => {
  it('turns money into seconds at the rate', () => {
    expect(secondsBoughtBy(18000, RATE)).toBe(20 * H); // $180.00 at $9/h
    expect(secondsBoughtBy(900, RATE)).toBe(H);
    expect(secondsBoughtBy(450, RATE)).toBe(H / 2);
  });

  it('refuses to divide by nothing rather than returning Infinity', () => {
    expect(secondsBoughtBy(18000, 0)).toBe(0);
    expect(secondsBoughtBy(0, RATE)).toBe(0);
    expect(secondsBoughtBy(-100, RATE)).toBe(0);
    expect(secondsBoughtBy(Number.NaN, RATE)).toBe(0);
  });

  it('is the inverse of referenceCentsFor to the nearest second', () => {
    // A cent buys 4 seconds at $9/h, so the rounding is worth well under a
    // cent and only decides where a shift boundary falls.
    expect(secondsBoughtBy(1, RATE)).toBe(4);
  });
});

describe('allocatePayment — the real case', () => {
  // 24 Aug 4h00, 25 Aug 4h05.6, 26 Aug 4h05.6, 27 Aug 4h00, 28 Aug 4h22.9
  const KHAYE = shifts(4 * H, 14736, 14738, 4 * H, 15777);
  const TOTAL = 4 * H + 14736 + 14738 + 4 * H + 15777; // 20h 34m 11s

  it('covers exactly what the money bought and leaves the rest owing', () => {
    const out = allocatePayment(KHAYE, 18000, RATE);

    expect(out.secondsCovered).toBe(20 * H);
    expect(out.unusedSeconds).toBe(0);
    // Four whole days, and the fifth part paid.
    expect(out.lines).toHaveLength(5);
    expect(out.lines.slice(0, 4).map((l) => l.paidSeconds)).toEqual([4 * H, 14736, 14738, 4 * H]);

    const last = out.lines[4];
    expect(last.shiftId).toBe('shift-5');
    expect(last.paidSeconds).toBeLessThan(last.totalSeconds);
    // The rollover itself: what the payment did NOT reach.
    expect(TOTAL - out.secondsCovered).toBe(2051); // 34m 11s
    expect(last.totalSeconds - last.paidSeconds).toBe(2051);
  });

  it('a second payment picks up exactly where the first stopped', () => {
    const first = allocatePayment(KHAYE, 18000, RATE);
    const paidByShift = new Map(first.lines.map((l) => [l.shiftId, l.paidSeconds]));
    const after = KHAYE.map((s) => ({
      ...s,
      unpaidSeconds: s.totalSeconds - (paidByShift.get(s.shiftId) ?? 0),
    }));

    // 2051 seconds are owing, which is worth 512.75 cents — so NO whole
    // amount buys it exactly. $5.13 buys 2052s and $5.12 buys 2048s. This is
    // why the over-payment refusal is measured in CENTS against the rounded
    // value of the unpaid hours, not in seconds: refusing every amount that
    // overshoots by less than a cent would make the last remainder of a week
    // literally unpayable.
    const second = allocatePayment(after, 513, RATE);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0].shiftId).toBe('shift-5');
    // It takes what is OWED, never what the money technically bought.
    expect(second.lines[0].paidSeconds).toBe(2051);
    expect(second.unusedSeconds).toBe(1); // sub-cent: 1 second is 0.25c

    // And the shift is then whole: nothing left to roll over.
    const paidNow = second.lines[0].paidSeconds;
    expect(after[4].unpaidSeconds - paidNow).toBe(0);
  });
});

describe('allocatePayment — the rules', () => {
  it('spends the OLDEST hours first', () => {
    const out = allocatePayment(shifts(4 * H, 4 * H, 4 * H), 900 * 5, RATE);
    // $45.00 = 5h: all of the first shift, an hour of the second, none of
    // the third.
    expect(out.lines.map((l) => [l.shiftId, l.paidSeconds])).toEqual([
      ['shift-1', 4 * H],
      ['shift-2', 1 * H],
    ]);
  });

  it('reports money that no unpaid hour could absorb, and covers what it can', () => {
    // $45.00 against 2h of work: 3h of it lands nowhere.
    const out = allocatePayment(shifts(2 * H), 900 * 5, RATE);
    expect(out.secondsCovered).toBe(2 * H);
    expect(out.unusedSeconds).toBe(3 * H);
  });

  it('skips a shift that is already fully paid rather than writing a zero line', () => {
    const partly: PayableRemainder[] = [
      { shiftId: 'done', clockInAt: '2026-08-24T13:00:00.000Z', totalSeconds: 4 * H, unpaidSeconds: 0 },
      { shiftId: 'owing', clockInAt: '2026-08-25T13:00:00.000Z', totalSeconds: 4 * H, unpaidSeconds: 4 * H },
    ];
    const out = allocatePayment(partly, 900, RATE);
    // A line covering no time is not a record of anything, and it would make
    // the payment look like it touched a shift it did not pay for.
    expect(out.lines.map((l) => l.shiftId)).toEqual(['owing']);
    expect(out.lines[0].paidSeconds).toBe(H);
  });

  it('takes only what is LEFT on a part-paid shift, not its whole length', () => {
    const partly: PayableRemainder[] = [
      { shiftId: 'half', clockInAt: '2026-08-24T13:00:00.000Z', totalSeconds: 4 * H, unpaidSeconds: H },
    ];
    const out = allocatePayment(partly, 900 * 4, RATE);
    expect(out.lines[0].paidSeconds).toBe(H);
    expect(out.unusedSeconds).toBe(3 * H);
  });

  it('records nothing at all for an unusable rate, rather than dividing by zero', () => {
    const out = allocatePayment(shifts(4 * H), 18000, 0);
    expect(out.lines).toEqual([]);
    expect(out.secondsCovered).toBe(0);
    expect(out.unusedSeconds).toBe(0);
  });

  it('does not re-sort what it is given — order is the caller\'s to decide', () => {
    // Passed newest first on purpose: this module spends in ARRAY order, so
    // the oldest-first rule lives in one place (the reader) and is visible
    // in its tests rather than hidden in two.
    const newestFirst = [...shifts(4 * H, 4 * H)].reverse();
    const out = allocatePayment(newestFirst, 900, RATE);
    expect(out.lines[0].shiftId).toBe('shift-2');
  });
});
