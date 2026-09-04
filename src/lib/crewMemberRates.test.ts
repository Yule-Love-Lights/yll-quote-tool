// Resolving the rate in force on a given day — ledger row 506.
//
// These are the pure halves of crewMemberRates.ts. They decide what every
// hour of somebody's work is worth, so the cases below are deliberately
// Jason's REAL history rather than round numbers:
//
//   ... to 11 Aug 2026   $10.00/h
//   12 Aug – 31 Aug      $13.00/h
//    1 Sep onward        $16.00/h

import { describe, expect, it } from 'vitest';

import {
  RATE_HISTORY_EPOCH,
  distinctRates,
  isEtDay,
  rateForDay,
  rateForShiftStart,
} from './crewMemberRates';

const JASON = [
  { rateCentsPerHour: 1000, effectiveFrom: RATE_HISTORY_EPOCH },
  { rateCentsPerHour: 1300, effectiveFrom: '2026-08-12' },
  { rateCentsPerHour: 1600, effectiveFrom: '2026-09-01' },
];

describe('rateForDay', () => {
  it('takes the newest rate that had already started', () => {
    expect(rateForDay(JASON, '2026-08-11')).toBe(1000);
    expect(rateForDay(JASON, '2026-08-12')).toBe(1300);
    expect(rateForDay(JASON, '2026-08-31')).toBe(1300);
    expect(rateForDay(JASON, '2026-09-01')).toBe(1600);
    expect(rateForDay(JASON, '2026-12-25')).toBe(1600);
  });

  it('is INCLUSIVE of the day a rate starts', () => {
    // The boundary is the whole point of storing a day rather than an
    // instant: work done on 12 Aug is paid at the new rate, not the old.
    expect(rateForDay(JASON, '2026-08-12')).toBe(1300);
    expect(rateForDay(JASON, '2026-08-11')).not.toBe(1300);
  });

  it('answers his oldest unpaid shift with AUGUST money, which is the whole row', () => {
    // 21 Aug 2026 is his oldest unpaid shift. Before this existed it
    // resolved to his current $16.00 and marked off about 19% fewer hours
    // than the money bought.
    expect(rateForDay(JASON, '2026-08-21')).toBe(1300);
  });

  it('returns 0 rather than the current rate when no row covers the day', () => {
    // The dangerous failure would be falling back to "their rate now",
    // because that is exactly the bug this module removes. A day with no
    // rate has no rate, and every caller refuses to convert.
    const late = [{ rateCentsPerHour: 1600, effectiveFrom: '2026-09-01' }];
    expect(rateForDay(late, '2026-08-21')).toBe(0);
    expect(rateForDay([], '2026-09-01')).toBe(0);
  });

  it('does not trust the order it is given', () => {
    const shuffled = [JASON[2], JASON[0], JASON[1]];
    expect(rateForDay(shuffled, '2026-08-21')).toBe(1300);
    expect(rateForDay([...JASON].reverse(), '2026-09-02')).toBe(1600);
  });

  it('treats a nonsense rate as no rate rather than as free work', () => {
    expect(rateForDay([{ rateCentsPerHour: 0, effectiveFrom: '2026-01-01' }], '2026-09-01')).toBe(0);
    expect(rateForDay([{ rateCentsPerHour: -5, effectiveFrom: '2026-01-01' }], '2026-09-01')).toBe(0);
  });
});

describe('rateForShiftStart', () => {
  it('uses the ET day, not the UTC one', () => {
    // 2026-09-01T02:00Z is 31 Aug 22:00 in New York, so this shift is
    // AUGUST work and is paid at the August rate. Reading the UTC date
    // instead would silently pay it at September rates.
    expect(rateForShiftStart(JASON, '2026-09-01T02:00:00.000Z')).toBe(1300);
    // ...and an hour of that same evening in ET terms is on the same side.
    expect(rateForShiftStart(JASON, '2026-08-31T23:00:00.000Z')).toBe(1300);
    // 1 Sep 09:00 ET is genuinely September.
    expect(rateForShiftStart(JASON, '2026-09-01T13:00:00.000Z')).toBe(1600);
  });

  it('takes the rate of the day a midnight-spanning shift STARTED', () => {
    // A shift that begins 22:00 ET on 31 Aug and runs past midnight is paid
    // at August's rate throughout — the same day-bucketing rule the hours
    // pages use, so a shift shown under Monday is paid at Monday's rate.
    expect(rateForShiftStart(JASON, '2026-09-01T02:30:00.000Z')).toBe(1300);
  });

  it('returns 0 for a timestamp it cannot read, rather than a plausible rate', () => {
    expect(rateForShiftStart(JASON, 'not a date')).toBe(0);
    expect(rateForShiftStart(JASON, '')).toBe(0);
  });
});

describe('distinctRates', () => {
  it('is one value while a payment stays inside one rate', () => {
    expect(distinctRates([{ rateCentsPerHour: 1300 }, { rateCentsPerHour: 1300 }])).toEqual([1300]);
  });

  it('names every rate a payment spans, ascending', () => {
    // This is what stops the pay panel printing "worked out at $16.00/hr"
    // over hours that were half earned at $13.00.
    expect(
      distinctRates([
        { rateCentsPerHour: 1600 },
        { rateCentsPerHour: 1300 },
        { rateCentsPerHour: 1600 },
      ]),
    ).toEqual([1300, 1600]);
  });

  it('ignores shifts with no rate, so a gap never counts as a second rate', () => {
    expect(distinctRates([{ rateCentsPerHour: 1600 }, { rateCentsPerHour: 0 }])).toEqual([1600]);
    expect(distinctRates([])).toEqual([]);
  });
});

describe('isEtDay', () => {
  it('accepts a real calendar day', () => {
    expect(isEtDay('2026-08-12')).toBe(true);
    expect(isEtDay('2028-02-29')).toBe(true); // a real leap day
  });

  it('refuses a day that does not exist', () => {
    expect(isEtDay('2026-02-29')).toBe(false); // 2026 is NOT a leap year
    expect(isEtDay('2026-02-31')).toBe(false);
    expect(isEtDay('2026-13-01')).toBe(false);
    expect(isEtDay('2026-00-10')).toBe(false);
  });

  it('refuses anything that is not a bare YYYY-MM-DD', () => {
    expect(isEtDay('2026-8-12')).toBe(false);
    expect(isEtDay('2026-08-12T00:00:00Z')).toBe(false);
    expect(isEtDay('')).toBe(false);
    expect(isEtDay(null)).toBe(false);
    expect(isEtDay(20260812)).toBe(false);
  });
});

describe('RATE_HISTORY_EPOCH', () => {
  it('is early enough that no shift can fall before a seeded first rate', () => {
    // The migration seeds every person's first row at this day, and staff
    // created afterwards get the same. A first row anchored to "when this
    // person was added" would leave row 507's imported pre-tool history
    // unpayable.
    expect(RATE_HISTORY_EPOCH < '2026-01-01').toBe(true);
    expect(isEtDay(RATE_HISTORY_EPOCH)).toBe(true);
  });
});
