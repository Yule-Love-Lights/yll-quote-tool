// Reading Jason's pre-tool time spreadsheet — ledger row 507.
//
// The dangerous part of this import is not the database write, it is deciding
// WHAT EACH ROW MEANS: which day a shift belongs to, whether it was already
// paid, and what the already-paid ones are worth. Those are the things that
// silently corrupt a year of payroll, so they live in a pure module and are
// tested here against the real file's actual shapes.

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_ET_HOUR,
  MAX_SAFE_DURATION_SECONDS,
  etInstant,
  isDay,
  paidValueCents,
  planImport,
  type TimesheetRow,
} from './timesheetImport';

const H = 3600;

function row(over: Partial<TimesheetRow> & { sheetRow: number; day: string }): TimesheetRow {
  return { durationSeconds: 8 * H, paid: false, rateBoundary: false, ...over };
}

/** Jason's real rates, the ones row 506 put in the database. */
const rateForDay = (day: string) => (day < '2026-08-12' ? 1000 : day < '2026-09-01' ? 1300 : 1600);

describe('etInstant — the day a shift lands on', () => {
  it('anchors at the ET hour, not UTC', () => {
    // 09:00 ET on a summer day is 13:00Z (EDT, UTC-4).
    expect(etInstant('2026-07-15', ANCHOR_ET_HOUR)).toBe('2026-07-15T13:00:00.000Z');
    // ...and 14:00Z in winter (EST, UTC-5). A hard-coded offset would put one
    // of these an hour out, and a shift near midnight on the wrong day.
    expect(etInstant('2026-01-15', ANCHOR_ET_HOUR)).toBe('2026-01-15T14:00:00.000Z');
  });

  it('is correct on both DST transition days', () => {
    // Spring forward 8 Mar 2026, fall back 1 Nov 2026. 09:00 ET is after the
    // 02:00 switch on both, so both days are already on the new offset.
    expect(etInstant('2026-03-08', ANCHOR_ET_HOUR)).toBe('2026-03-08T13:00:00.000Z');
    expect(etInstant('2026-03-07', ANCHOR_ET_HOUR)).toBe('2026-03-07T14:00:00.000Z');
    expect(etInstant('2026-11-01', ANCHOR_ET_HOUR)).toBe('2026-11-01T14:00:00.000Z');
    expect(etInstant('2026-10-31', ANCHOR_ET_HOUR)).toBe('2026-10-31T13:00:00.000Z');
  });

  it('adds the duration on top', () => {
    expect(etInstant('2026-07-15', ANCHOR_ET_HOUR, 8 * H)).toBe('2026-07-15T21:00:00.000Z');
  });
});

describe('planImport — what becomes a shift', () => {
  it('turns a row into a shift on its own ET day, for its exact duration', () => {
    const plan = planImport([row({ sheetRow: 5, day: '2026-07-15', durationSeconds: 29340 })]);
    expect(plan.shifts).toHaveLength(1);
    const s = plan.shifts[0];
    expect(s.day).toBe('2026-07-15');
    expect(s.durationSeconds).toBe(29340);
    expect(Date.parse(s.clockOutAt) - Date.parse(s.clockInAt)).toBe(29340 * 1000);
  });

  it('carries the PAID flag from the green fill, since nothing else records it', () => {
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-05-01', paid: true }),
      row({ sheetRow: 6, day: '2026-08-01', paid: false }),
    ]);
    expect(plan.shifts.map((s) => s.paid)).toEqual([true, false]);
    expect(plan.totals.paidShifts).toBe(1);
    expect(plan.totals.unpaidShifts).toBe(1);
  });

  it('reports the yellow rate boundaries so they can be checked against the rate history', () => {
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-08-12', rateBoundary: true }),
      row({ sheetRow: 6, day: '2026-09-01', rateBoundary: true }),
      row({ sheetRow: 7, day: '2026-09-02' }),
    ]);
    // These are exactly the two days Jason named independently, and the file
    // agreeing with him is worth asserting rather than assuming.
    expect(plan.rateBoundaries).toEqual(['2026-08-12', '2026-09-01']);
  });
});

describe('planImport — what is refused, and why it is a SKIP not a throw', () => {
  it('skips a row with no duration, naming it, rather than making a zero-length shift', () => {
    // The last row of a live sheet is today, still being worked, recorded as 0.
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-09-03', durationSeconds: 8 * H }),
      row({ sheetRow: 6, day: '2026-09-04', durationSeconds: 0 }),
    ]);
    expect(plan.shifts.map((s) => s.day)).toEqual(['2026-09-03']);
    expect(plan.skipped).toEqual([
      { sheetRow: 6, day: '2026-09-04', reason: 'no duration recorded' },
    ]);
  });

  it('skips a duration that cannot fit before midnight instead of moving it', () => {
    // Moving it to the next day would put those hours on the wrong day and,
    // across 12 Aug or 1 Sep, at the wrong pay rate.
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-08-11', durationSeconds: MAX_SAFE_DURATION_SECONDS + 1 }),
    ]);
    expect(plan.shifts).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('crossing midnight');
  });

  it('skips a DUPLICATE day rather than guessing which row is right', () => {
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-07-15', durationSeconds: 4 * H }),
      row({ sheetRow: 9, day: '2026-07-15', durationSeconds: 6 * H }),
    ]);
    expect(plan.shifts).toHaveLength(1);
    expect(plan.shifts[0].sheetRow).toBe(5);
    expect(plan.skipped[0]).toEqual({
      sheetRow: 9,
      day: '2026-07-15',
      reason: 'duplicate of sheet row 5',
    });
  });

  it('accounts for EVERY row: imported plus skipped is the whole file', () => {
    const rows = [
      row({ sheetRow: 5, day: '2026-07-15' }),
      row({ sheetRow: 6, day: '2026-07-16', durationSeconds: 0 }),
      row({ sheetRow: 7, day: 'not-a-date' }),
      row({ sheetRow: 8, day: '2026-07-15' }),
    ];
    const plan = planImport(rows);
    expect(plan.shifts.length + plan.skipped.length).toBe(rows.length);
    expect(plan.totals.rows).toBe(4);
  });
});

describe('paidValueCents — what the already-paid hours came to', () => {
  it('values each day at ITS OWN rate, not one rate for the file', () => {
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-07-01', durationSeconds: 4 * H, paid: true }), // $10
      row({ sheetRow: 6, day: '2026-08-20', durationSeconds: 4 * H, paid: true }), // $13
      row({ sheetRow: 7, day: '2026-09-02', durationSeconds: 4 * H, paid: true }), // $16
    ]);
    expect(paidValueCents(plan.shifts, rateForDay).cents).toBe(4000 + 5200 + 6400);
  });

  it('ignores the UNPAID rows, which is the whole distinction', () => {
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-07-01', durationSeconds: 4 * H, paid: true }),
      row({ sheetRow: 6, day: '2026-07-02', durationSeconds: 4 * H, paid: false }),
    ]);
    expect(paidValueCents(plan.shifts, rateForDay).cents).toBe(4000);
  });

  it('rounds PER SHIFT, matching referenceCentsFor, so the settlement lands exactly', () => {
    // A day of 1801s at $10.00/hr is 500.28 cents. Round each shift and three
    // of them come to 1500; accumulate exactly and round once at the end and
    // they come to 1501. That one cent is not cosmetic: the settlement is
    // spent oldest-first, so a cent too much spills into the first UNPAID day
    // and marks four seconds of it paid that nobody paid for.
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-07-01', durationSeconds: 1801, paid: true }),
      row({ sheetRow: 6, day: '2026-07-02', durationSeconds: 1801, paid: true }),
      row({ sheetRow: 7, day: '2026-07-03', durationSeconds: 1801, paid: true }),
    ]);
    expect(paidValueCents(plan.shifts, rateForDay).cents).toBe(1500);
    expect(Math.round((3 * 1801 * 1000) / 3600)).toBe(1501); // the wrong way
  });

  it('NAMES a paid day with no rate instead of quietly shrinking the payment', () => {
    // Skipping it and adding zero for it come to the same total, so the guard
    // is invisible in the number — which is exactly how this hole hides. The
    // consequence is real: such a day stays UNPAID after an import that read
    // it as paid. The caller gets told, and the import script refuses.
    const plan = planImport([
      row({ sheetRow: 5, day: '2026-07-01', durationSeconds: 4 * H, paid: true }),
      row({ sheetRow: 6, day: '2026-07-02', durationSeconds: 4 * H, paid: true }),
    ]);
    const out = paidValueCents(plan.shifts, (d) => (d === '2026-07-02' ? 0 : 1000));
    expect(out.cents).toBe(4000);
    expect(out.unratedDays).toEqual(['2026-07-02']);
  });

  it('reports no unrated days when every day has a rate', () => {
    const plan = planImport([row({ sheetRow: 5, day: '2026-07-01', durationSeconds: 4 * H, paid: true })]);
    expect(paidValueCents(plan.shifts, rateForDay).unratedDays).toEqual([]);
  });
});

describe('isDay', () => {
  it('accepts a real day and refuses one that does not exist', () => {
    expect(isDay('2026-07-15')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isDay('2026-7-15')).toBe(false);
    expect(isDay(null)).toBe(false);
  });
});
