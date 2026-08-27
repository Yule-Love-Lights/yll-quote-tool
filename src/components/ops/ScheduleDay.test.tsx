// Row 364 (S47 wrap staff-lens MED + this fix round's own technical-lens MED):
// ScheduleDay had NO test file, which is why #897's fix round could gate the
// "you are looking at a different day" warning on `loading` and nobody noticed
// that (a) a FAILED refetch hides the warning while the stale day stays on
// screen, and (b) `loading` was never even set by a date change, so the label
// was unreachable on the one path it was written for.
//
// The whole decision is now a pure exported function, so the state machine is
// pinned directly (this repo has no jsdom; the component itself gets the same
// static react-dom/server render its siblings use).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduleDay, defaultScheduleDay, isStaleDay, scheduleStatusNote } from './ScheduleDay';

describe('defaultScheduleDay (row 335 — the day the page opens on)', () => {
  it('an ET evening stays on the ET day, where the UTC slice already reads tomorrow', () => {
    // 2026-08-26 23:30 ET (EDT, UTC-4) = 2026-08-27T03:30Z. The old
    // `toISOString().slice(0, 10)` read 2026-08-27 — tomorrow's schedule.
    const eveningEt = new Date('2026-08-27T03:30:00Z');
    expect(eveningEt.toISOString().slice(0, 10)).toBe('2026-08-27'); // the bug
    expect(defaultScheduleDay(eveningEt)).toBe('2026-08-26'); // the fix
  });

  it('a winter (EST, UTC-5) evening too — 7pm was already enough then', () => {
    // 2026-01-15 19:30 ET = 2026-01-16T00:30Z.
    const winterEvening = new Date('2026-01-16T00:30:00Z');
    expect(winterEvening.toISOString().slice(0, 10)).toBe('2026-01-16');
    expect(defaultScheduleDay(winterEvening)).toBe('2026-01-15');
  });

  it('midday the two clocks agree', () => {
    const noonEt = new Date('2026-08-26T16:00:00Z'); // 12:00 EDT
    expect(defaultScheduleDay(noonEt)).toBe('2026-08-26');
  });
});

const TODAY = '2026-08-24';
const PICKED = '2026-08-25';

describe('scheduleStatusNote (row 364 — the status line above the day sections)', () => {
  it('first load: busy, and nothing is stale yet (the component shows its skeleton for this state)', () => {
    expect(scheduleStatusNote(true, TODAY, null)).toEqual({ text: 'Refreshing…', tone: 'busy' });
  });

  it('settled on the picked day: no note at all', () => {
    expect(scheduleStatusNote(false, TODAY, TODAY)).toBeNull();
  });

  it('an assign/unassign refresh of the SAME day says Refreshing, never names a day', () => {
    const note = scheduleStatusNote(true, TODAY, TODAY);
    expect(note).toEqual({ text: 'Refreshing…', tone: 'busy' });
  });

  it('a date change in flight names BOTH days, so on-screen content is not read as the new day', () => {
    expect(scheduleStatusNote(true, PICKED, TODAY)).toEqual({
      text: `Loading ${PICKED}… (showing ${TODAY} below)`,
      tone: 'busy',
    });
  });

  it('THE REGRESSION: a FAILED date-change refetch keeps warning, and says the load failed', () => {
    // loading has flipped back to false, but the sections below still hold
    // TODAY's crew and capacity while the picker reads PICKED. Before this fix
    // the note disappeared here — the exact state a dispatcher must not misread.
    expect(scheduleStatusNote(false, PICKED, TODAY)).toEqual({
      text: `Could not load ${PICKED} — showing ${TODAY} below.`,
      tone: 'error',
    });
  });

  it('a failed refresh of the SAME day shows no stale note (the content still belongs to that day)', () => {
    expect(scheduleStatusNote(false, TODAY, TODAY)).toBeNull();
  });

  it('the note is present for every state where loadedDate disagrees with the picker, busy or not', () => {
    for (const loading of [true, false]) {
      const note = scheduleStatusNote(loading, PICKED, TODAY);
      expect(note).not.toBeNull();
      expect(note!.text).toContain(PICKED);
      expect(note!.text).toContain(TODAY);
    }
  });
});

describe('ScheduleDay (initial render)', () => {
  it('renders the day picker and the first-load skeleton, never a stale-day warning', () => {
    const html = renderToStaticMarkup(
      <ScheduleDay crew={[{ id: 'c1', displayName: 'Alex', active: true }]} />,
    );
    expect(html).toContain('type="date"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('Could not load');
    expect(html).not.toContain('showing');
  });
});

// Row 364 fix round (staff lens HIGH): the warning alone was not enough. Every
// write this view makes is stamped with the PICKER's date while the rows on
// screen belong to loadedDate, so during a stale window a click would assign
// crew to a day nobody is looking at. isStaleDay is the predicate behind both
// the warning and the disabled controls / mutate() guard, so it is pinned here.
describe('isStaleDay (row 364 — the write guard, not just the label)', () => {
  it('is false before anything has loaded (nothing on screen to be wrong about)', () => {
    expect(isStaleDay('2026-08-24', null)).toBe(false);
  });

  it('is false when the loaded day IS the picked day', () => {
    expect(isStaleDay('2026-08-24', '2026-08-24')).toBe(false);
  });

  it('is true whenever the loaded day differs from the picker, regardless of any load state', () => {
    expect(isStaleDay('2026-08-25', '2026-08-24')).toBe(true);
  });

  it('agrees with the status note: stale is exactly the set of states that name two days', () => {
    for (const [date, loaded] of [
      ['2026-08-24', null],
      ['2026-08-24', '2026-08-24'],
      ['2026-08-25', '2026-08-24'],
    ] as [string, string | null][]) {
      const note = scheduleStatusNote(false, date, loaded);
      expect(isStaleDay(date, loaded)).toBe(note !== null && note.tone === 'error');
    }
  });
});
