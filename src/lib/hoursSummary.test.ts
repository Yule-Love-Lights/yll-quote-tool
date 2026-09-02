import { describe, expect, it } from 'vitest';
import { formatHours, summarizeHours, type HoursShift, type HoursStaff } from './hoursSummary';

// A summer instant: 2026-09-02 10:00 ET = 14:00Z. DST in force, ET = UTC-4.
const NOW = '2026-09-02T14:00:00.000Z';

const ANN: HoursStaff = { id: 'ann', displayName: 'Ann', active: true, isOffice: true };
const BIG: HoursStaff = { id: 'big', displayName: 'Big James', active: true, isOffice: false };
const KELLY: HoursStaff = { id: 'kelly', displayName: 'Kelly', active: true, isOffice: true };
const OLD: HoursStaff = { id: 'old', displayName: 'Aaron', active: false, isOffice: true };

function shift(over: Partial<HoursShift> & { id: string; clockInAt: string }): HoursShift {
  return {
    crewMemberId: 'ann',
    clockOutAt: null,
    source: 'office',
    closeSource: null,
    ...over,
  };
}

const H = 3600;

describe('summarizeHours', () => {
  it('gives every staff member a row, zeros included, office before field, inactive last', () => {
    const rows = summarizeHours([BIG, OLD, KELLY, ANN], [], [], NOW);
    expect(rows.map((r) => r.displayName)).toEqual(['Ann', 'Kelly', 'Aaron', 'Big James']);
    for (const r of rows) {
      expect(r.allTimeSeconds).toBe(0);
      expect(r.shiftCount).toBe(0);
      expect(r.openShift).toBeNull();
      expect(r.autoClosed).toEqual({ count: 0, seconds: 0 });
    }
  });

  it('subtracts breaks: the paid figure is the envelope minus break time', () => {
    const rows = summarizeHours(
      [ANN],
      [shift({ id: 's1', clockInAt: '2026-09-02T12:00:00Z', clockOutAt: '2026-09-02T13:00:00Z' })],
      [{ shiftId: 's1', startedAt: '2026-09-02T12:15:00Z', endedAt: '2026-09-02T12:30:00Z' }],
      NOW,
    );
    expect(rows[0]!.todaySeconds).toBe(45 * 60);
    expect(rows[0]!.allTimeSeconds).toBe(45 * 60);
    expect(rows[0]!.shiftCount).toBe(1);
  });

  it('counts an open shift up to now and reports when it started', () => {
    const rows = summarizeHours(
      [ANN],
      [shift({ id: 's1', clockInAt: '2026-09-02T12:00:00Z', source: 'telegram' })],
      [],
      NOW,
    );
    expect(rows[0]!.todaySeconds).toBe(2 * H);
    expect(rows[0]!.openShift).toEqual({ clockInAt: '2026-09-02T12:00:00Z', source: 'telegram' });
  });

  it('puts a shift on the ET day it started, even when UTC has already rolled over', () => {
    // 11:30 PM ET on Sep 1 is 03:30Z on Sep 2. A UTC bucket would call this
    // "today"; the business day says yesterday.
    const rows = summarizeHours(
      [ANN],
      [shift({ id: 's1', clockInAt: '2026-09-02T03:30:00Z', clockOutAt: '2026-09-02T04:30:00Z' })],
      [],
      NOW,
    );
    expect(rows[0]!.todaySeconds).toBe(0);
    expect(rows[0]!.last7Seconds).toBe(H);
  });

  it('does not split a shift that crosses midnight; the whole of it lands on the start day', () => {
    const rows = summarizeHours(
      [ANN],
      // Sep 1 22:00 ET to Sep 2 02:00 ET.
      [shift({ id: 's1', clockInAt: '2026-09-02T02:00:00Z', clockOutAt: '2026-09-02T06:00:00Z' })],
      [],
      NOW,
    );
    expect(rows[0]!.todaySeconds).toBe(0);
    expect(rows[0]!.last7Seconds).toBe(4 * H);
  });

  it('rolling windows include today and count ET days, so a 7-day window is today plus six', () => {
    // Each shift is one hour, starting at noon ET on the given day.
    const on = (id: string, day: string) =>
      shift({ id, clockInAt: `${day}T16:00:00Z`, clockOutAt: `${day}T17:00:00Z` });
    const rows = summarizeHours(
      [ANN],
      [
        on('today', '2026-09-02'),
        on('six-ago', '2026-08-27'), // inside the 7-day window (its oldest day)
        on('seven-ago', '2026-08-26'), // just outside it
        on('twentynine-ago', '2026-08-04'), // inside the 30-day window (its oldest day)
        on('thirty-ago', '2026-08-03'), // just outside it
        on('ancient', '2026-01-10'),
      ],
      [],
      NOW,
    );
    const r = rows[0]!;
    expect(r.todaySeconds).toBe(H);
    expect(r.last7Seconds).toBe(2 * H);
    expect(r.last30Seconds).toBe(4 * H);
    expect(r.allTimeSeconds).toBe(6 * H);
    expect(r.shiftCount).toBe(6);
  });

  it('reports midnight auto-closes separately while leaving them inside the totals', () => {
    const rows = summarizeHours(
      [ANN],
      [
        shift({ id: 'real', clockInAt: '2026-09-01T12:00:00Z', clockOutAt: '2026-09-01T16:00:00Z' }),
        shift({
          id: 'forgot',
          clockInAt: '2026-08-31T12:00:00Z',
          clockOutAt: '2026-09-01T04:00:00Z', // midnight ET sweep, 16h envelope
          closeSource: 'system',
        }),
      ],
      [],
      NOW,
    );
    const r = rows[0]!;
    expect(r.allTimeSeconds).toBe(20 * H);
    expect(r.autoClosed).toEqual({ count: 1, seconds: 16 * H });
  });

  it('keeps a shift whose crew id matches no staff row, under (unknown), rather than dropping it', () => {
    const rows = summarizeHours(
      [ANN],
      [
        shift({
          id: 's1',
          crewMemberId: 'ghost',
          clockInAt: '2026-09-02T12:00:00Z',
          clockOutAt: '2026-09-02T13:00:00Z',
        }),
      ],
      [],
      NOW,
    );
    const ghost = rows.find((r) => r.crewMemberId === 'ghost');
    expect(ghost?.displayName).toBe('(unknown)');
    expect(ghost?.allTimeSeconds).toBe(H);
    expect(rows.find((r) => r.crewMemberId === 'ann')?.allTimeSeconds).toBe(0);
  });

  it('a malformed clock-in still counts as a shift, with zero hours, so count and hours cannot silently disagree', () => {
    const rows = summarizeHours(
      [ANN],
      [shift({ id: 's1', clockInAt: 'not-a-date', clockOutAt: '2026-09-02T13:00:00Z' })],
      [],
      NOW,
    );
    expect(rows[0]!.shiftCount).toBe(1);
    expect(rows[0]!.allTimeSeconds).toBe(0);
  });
});

describe('formatHours', () => {
  it('renders hours and zero-padded minutes, and bare minutes under an hour', () => {
    expect(formatHours(0)).toBe('0m');
    expect(formatHours(45 * 60)).toBe('45m');
    expect(formatHours(H + 5 * 60)).toBe('1h 05m');
    expect(formatHours(10 * H + 30 * 60)).toBe('10h 30m');
  });

  it('rounds to the nearest minute and never goes negative', () => {
    expect(formatHours(89)).toBe('1m');
    expect(formatHours(90)).toBe('2m');
    expect(formatHours(-5)).toBe('0m');
  });
});
