// Spending a payment across unpaid hours, oldest first, with the remainder
// rolling over — Jason's rule, 2026-09-03.
//
// The case that produced it is the first test below and is real: $180.00 was
// paid to Khaye at $9.00/h for the five weekdays 24–28 Aug, which come to
// 20h 34m. The money buys exactly 20h, so 34 minutes must be left owing
// rather than written off by a payment that did not cover it.
//
// EACH SHIFT CARRIES ITS OWN RATE since 2026-09-04 (ledger row 506), because
// a payment reaching back across a raise buys different amounts of time on
// either side of it. The `spans a raise` block below is the whole reason that
// change exists, and it is Jason's own live data.

import { describe, expect, it } from 'vitest';

import {
  allocatePayment,
  excessOverHours,
  valueOfHours,
  type PayableRemainder,
} from './shiftSettlements';

const H = 3600;
const RATE = 900; // $9.00/hour, Khaye's real rate

/** Oldest first, the order allocatePayment consumes in. */
function shifts(...secs: number[]): PayableRemainder[] {
  return secs.map((s, i) => ({
    shiftId: `shift-${i + 1}`,
    clockInAt: `2026-08-${String(24 + i).padStart(2, '0')}T13:00:00.000Z`,
    totalSeconds: s,
    unpaidSeconds: s,
    needsReview: false,
    rateCentsPerHour: RATE,
  }));
}

describe('allocatePayment — the real case', () => {
  // 24 Aug 4h00, 25 Aug 4h05.6, 26 Aug 4h05.6, 27 Aug 4h00, 28 Aug 4h22.9
  const KHAYE = shifts(4 * H, 14736, 14738, 4 * H, 15777);
  const TOTAL = 4 * H + 14736 + 14738 + 4 * H + 15777; // 20h 34m 11s

  it('covers exactly what the money bought and leaves the rest owing', () => {
    const out = allocatePayment(KHAYE, 18000);

    expect(out.secondsCovered).toBe(20 * H);
    expect(out.unusedCents).toBe(0);
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

  it('stamps the rate and the reference on every line', () => {
    const out = allocatePayment(KHAYE, 18000);
    expect(out.lines.every((l) => l.rateCentsPerHour === RATE)).toBe(true);
    expect(out.spentCents).toBe(out.lines.reduce((n, l) => n + l.referenceCents, 0));

    // ONE CENT OVER the $180.00 paid, and that is correct rather than a bug
    // to chase. Each line's `reference_cents` is its own seconds rounded to
    // the nearest cent, and five independent roundings do not sum to the
    // rounding of the sum. Verified against the real settlement in
    // production on 2026-09-04, which predates this change: its five lines
    // are 3432 + 3600 + 3600 + 3684 + 3685 = 18001 against $180.00.
    //
    // Nothing depends on the two being equal. `total_cents` is the record of
    // what was handed over; this is what the hours came to; phase 3 made
    // them deliberately independent and the rollover kept it that way.
    expect(out.spentCents).toBe(18001);

    // The SECONDS, by contrast, are exact — 20h to the second — which is the
    // property that actually decides how much of somebody's week is marked
    // off, and the one the cent-second arithmetic exists to protect.
    expect(out.secondsCovered).toBe(20 * H);
  });

  it('a second payment picks up exactly where the first stopped', () => {
    const first = allocatePayment(KHAYE, 18000);
    const paidByShift = new Map(first.lines.map((l) => [l.shiftId, l.paidSeconds]));
    const after = KHAYE.map((s) => ({
      ...s,
      unpaidSeconds: s.totalSeconds - (paidByShift.get(s.shiftId) ?? 0),
    }));

    // 2051 seconds are owing, which is worth 512.75 cents, so no whole
    // amount buys it exactly. $5.13 is the rounded value of those hours, and
    // walking in MONEY rather than in seconds is what lets it finish the
    // shift cleanly: the whole remaining shift costs 513 cents and the
    // payment has 513 cents, so it buys all of it.
    const second = allocatePayment(after, 513);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0].shiftId).toBe('shift-5');
    // It takes what is OWED, never what the money technically bought.
    expect(second.lines[0].paidSeconds).toBe(2051);
    expect(second.unusedCents).toBe(0);

    // And the shift is then whole: nothing left to roll over.
    const paidNow = second.lines[0].paidSeconds;
    expect(after[4].unpaidSeconds - paidNow).toBe(0);
  });
});

describe('allocatePayment — a payment that spans a raise', () => {
  // Jason's own history, and the reason ledger row 506 exists:
  //   ... to 11 Aug   $10.00/h
  //   12 Aug – 31 Aug $13.00/h
  //    1 Sep onward   $16.00/h
  const AUG = 1300;
  const SEP = 1600;

  /** One 4-hour shift in August, one in September. */
  const ACROSS: PayableRemainder[] = [
    {
      shiftId: 'aug-21',
      clockInAt: '2026-08-21T13:00:00.000Z',
      totalSeconds: 4 * H,
      unpaidSeconds: 4 * H,
      needsReview: false,
      rateCentsPerHour: AUG,
    },
    {
      shiftId: 'sep-02',
      clockInAt: '2026-09-02T13:00:00.000Z',
      totalSeconds: 4 * H,
      unpaidSeconds: 4 * H,
      needsReview: false,
      rateCentsPerHour: SEP,
    },
  ];

  it('buys each shift at its OWN rate, so 8 hours costs $116.00 and not $128.00', () => {
    // 4h at $13.00 is $52.00; 4h at $16.00 is $64.00.
    expect(valueOfHours(ACROSS)).toBe(5200 + 6400);

    const out = allocatePayment(ACROSS, 11600);
    expect(out.lines.map((l) => [l.shiftId, l.paidSeconds, l.rateCentsPerHour])).toEqual([
      ['aug-21', 4 * H, AUG],
      ['sep-02', 4 * H, SEP],
    ]);
    expect(out.secondsCovered).toBe(8 * H);
    expect(out.unusedCents).toBe(0);
  });

  it('is the DEFECT this row exists to fix: one rate marks off the wrong hours', () => {
    // $52.00 is exactly the August shift at the August rate, and it clears
    // it whole.
    const correct = allocatePayment([ACROSS[0]], 5200);
    expect(correct.secondsCovered).toBe(4 * H);
    expect(correct.unusedCents).toBe(0);

    // The old behaviour, reproduced by pretending that August shift was
    // worth today's rate: the same $52.00 now buys only 3h 15m, so 45
    // minutes Jason actually earned stay marked unpaid. 18.75% fewer hours,
    // which is the ~19% named in the ledger row.
    const wrong = allocatePayment([{ ...ACROSS[0], rateCentsPerHour: SEP }], 5200);
    expect(wrong.secondsCovered).toBe(3 * H + 900);
    expect(4 * H - wrong.secondsCovered).toBe(2700);
  });

  it('stops mid-August rather than paying September at August prices', () => {
    // $26.00 is 2h at the August rate and reaches nothing later.
    const out = allocatePayment(ACROSS, 2600);
    expect(out.lines.map((l) => l.shiftId)).toEqual(['aug-21']);
    expect(out.lines[0].paidSeconds).toBe(2 * H);
    expect(out.lines[0].rateCentsPerHour).toBe(AUG);
  });

  it('leaves a shift with NO rate on record unpaid rather than guessing one', () => {
    // A day earlier than anybody's first rate row resolves to 0. Buying it
    // at a neighbour's rate would be inventing payroll, and buying it for
    // nothing would mark it paid for free — so it is skipped, stays visible,
    // and the money moves on to the next shift that does have a rate.
    const withGap: PayableRemainder[] = [
      { ...ACROSS[0], shiftId: 'no-rate', rateCentsPerHour: 0 },
      ACROSS[1],
    ];
    const out = allocatePayment(withGap, 6400);
    expect(out.lines.map((l) => l.shiftId)).toEqual(['sep-02']);
    expect(out.lines[0].paidSeconds).toBe(4 * H);
    // And it is not counted as money the hours could not absorb, because it
    // was spent — on the shift that could take it.
    expect(out.unusedCents).toBe(0);
  });

  it('values a rateless shift at nothing, so it never inflates the ceiling', () => {
    const withGap = [
      { unpaidSeconds: 4 * H, rateCentsPerHour: 0 },
      { unpaidSeconds: 4 * H, rateCentsPerHour: SEP },
    ];
    expect(valueOfHours(withGap)).toBe(6400);
  });
});

describe('allocatePayment — the rules', () => {
  it('spends the OLDEST hours first', () => {
    const out = allocatePayment(shifts(4 * H, 4 * H, 4 * H), 900 * 5);
    // $45.00 = 5h: all of the first shift, an hour of the second, none of
    // the third.
    expect(out.lines.map((l) => [l.shiftId, l.paidSeconds])).toEqual([
      ['shift-1', 4 * H],
      ['shift-2', 1 * H],
    ]);
  });

  it('reports money that no unpaid hour could absorb, and covers what it can', () => {
    // $45.00 against 2h of work: $27.00 of it lands nowhere.
    const out = allocatePayment(shifts(2 * H), 900 * 5);
    expect(out.secondsCovered).toBe(2 * H);
    expect(out.unusedCents).toBe(2700);
    expect(out.spentCents).toBe(1800);
  });

  it('skips a shift that is already fully paid rather than writing a zero line', () => {
    const partly: PayableRemainder[] = [
      { shiftId: 'done', clockInAt: '2026-08-24T13:00:00.000Z', totalSeconds: 4 * H, unpaidSeconds: 0, needsReview: false, rateCentsPerHour: RATE },
      { shiftId: 'owing', clockInAt: '2026-08-25T13:00:00.000Z', totalSeconds: 4 * H, unpaidSeconds: 4 * H, needsReview: false, rateCentsPerHour: RATE },
    ];
    const out = allocatePayment(partly, 900);
    // A line covering no time is not a record of anything, and it would make
    // the payment look like it touched a shift it did not pay for.
    expect(out.lines.map((l) => l.shiftId)).toEqual(['owing']);
    expect(out.lines[0].paidSeconds).toBe(H);
  });

  it('takes only what is LEFT on a part-paid shift, not its whole length', () => {
    const partly: PayableRemainder[] = [
      { shiftId: 'half', clockInAt: '2026-08-24T13:00:00.000Z', totalSeconds: 4 * H, unpaidSeconds: H, needsReview: false, rateCentsPerHour: RATE },
    ];
    const out = allocatePayment(partly, 900 * 4);
    expect(out.lines[0].paidSeconds).toBe(H);
    // The line covers one hour, so it costs $9.00 and $27.00 is left over —
    // measured against the UNPAID hour, never the whole 4-hour shift.
    expect(out.lines[0].referenceCents).toBe(900);
    expect(out.unusedCents).toBe(2700);
  });

  it('records nothing at all when no shift has a usable rate', () => {
    const out = allocatePayment(
      shifts(4 * H).map((s) => ({ ...s, rateCentsPerHour: 0 })),
      18000,
    );
    expect(out.lines).toEqual([]);
    expect(out.secondsCovered).toBe(0);
    expect(out.spentCents).toBe(0);
    // The whole amount is unspent, which is exactly what it is. The callers
    // refuse before reaching this — `recordShiftSettlement` with `no-rate`,
    // the panel with the same message — so nobody sees this as a $180.00
    // bonus; it is here so the function's own answer stays honest.
    expect(out.unusedCents).toBe(18000);
  });

  it('does not re-sort what it is given — order is the caller\'s to decide', () => {
    // Passed newest first on purpose: this module spends in ARRAY order, so
    // the oldest-first rule lives in one place (the reader) and is visible
    // in its tests rather than hidden in two.
    const newestFirst = [...shifts(4 * H, 4 * H)].reverse();
    const out = allocatePayment(newestFirst, 900);
    expect(out.lines[0].shiftId).toBe('shift-2');
  });

  it('never writes a line longer than the shift, however the rounding falls', () => {
    // One cent short of the whole 4-hour shift at $9.00/h. The partial take
    // rounds to the NEAREST second, and at a rate where a cent buys 4 seconds
    // that boundary can round either way, so the cap against unpaidSeconds is
    // what makes this safe rather than lucky. The database trigger would
    // refuse an over-long line; a refusal is a worse answer than the right
    // number.
    const out = allocatePayment(shifts(4 * H), 3599);
    expect(out.lines[0].paidSeconds).toBeLessThanOrEqual(4 * H);
    expect(out.lines[0].paidSeconds).toBe(14396);
  });
});

describe('valueOfHours', () => {
  it('sums each shift at its own rate rather than multiplying by one', () => {
    expect(
      valueOfHours([
        { unpaidSeconds: 4 * H, rateCentsPerHour: 1300 },
        { unpaidSeconds: 4 * H, rateCentsPerHour: 1600 },
      ]),
    ).toBe(11600);
  });

  it('is zero for nothing owing', () => {
    expect(valueOfHours([])).toBe(0);
    expect(valueOfHours([{ unpaidSeconds: 0, rateCentsPerHour: 1600 }])).toBe(0);
  });
});

describe('excessOverHours', () => {
  it('is zero while the money fits inside the unpaid hours', () => {
    expect(excessOverHours(17370, 17370)).toBe(0);
    expect(excessOverHours(100, 17370)).toBe(0);
  });

  it('names the difference when the money is worth more than the hours', () => {
    // $200.00 against $173.70 of unpaid time: the overtime case.
    expect(excessOverHours(20000, 17370)).toBe(2630);
  });

  it('is zero for an unparsed amount, so an empty box warns about nothing', () => {
    expect(excessOverHours(null, 17370)).toBe(0);
    expect(excessOverHours(Number.NaN, 17370)).toBe(0);
  });

  it('never goes negative, and shrugs off a nonsense ceiling', () => {
    expect(excessOverHours(500, -1)).toBe(0);
    expect(excessOverHours(500, Number.NaN)).toBe(0);
  });
});
