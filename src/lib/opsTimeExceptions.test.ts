import { describe, expect, it } from 'vitest';

import { classifyTimeExceptions, DEFAULT_STALE_SEGMENT_HOURS } from './opsTimeExceptions';

const NOW = new Date('2026-08-18T18:00:00Z'); // 14:00 ET on the 18th

const shift = (id: string, clockInAt: string, clockOutAt: string | null = null) => ({
  id,
  crewMemberId: `crew-${id}`,
  clockInAt,
  clockOutAt,
});
const brk = (id: string, shiftId: string, startedAt: string) => ({
  id,
  shiftId,
  crewMemberId: `crew-${shiftId}`,
  startedAt,
});
const seg = (id: string, shiftId: string, arrivedAt: string) => ({
  id,
  shiftId,
  crewMemberId: `crew-${shiftId}`,
  arrivedAt,
});

const run = (input: Partial<Parameters<typeof classifyTimeExceptions>[0]> = {}) =>
  classifyTimeExceptions({
    shifts: [],
    openBreaks: [],
    openSegments: [],
    now: NOW,
    ...input,
  });

describe('the orphan case: a child row open under a CLOSED shift', () => {
  // This is the TOCTOU outcome. No closer will ever touch these, because every
  // closer requires an open shift — so without this queue they sit forever.
  it('flags a break still open on a closed shift', () => {
    const out = run({
      shifts: [shift('s1', '2026-08-18T12:00:00Z', '2026-08-18T17:00:00Z')],
      openBreaks: [brk('b1', 's1', '2026-08-18T13:00:00Z')],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'open_break_on_closed_shift',
      shiftId: 's1',
      rowId: 'b1',
    });
  });

  it('flags a segment still open on a closed shift', () => {
    const out = run({
      shifts: [shift('s1', '2026-08-18T12:00:00Z', '2026-08-18T17:00:00Z')],
      openSegments: [seg('g1', 's1', '2026-08-18T13:00:00Z')],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'open_segment_on_closed_shift', rowId: 'g1' });
  });

  it('says plainly that pay is unaffected, so nobody panics about a paycheck', () => {
    const out = run({
      shifts: [shift('s1', '2026-08-18T12:00:00Z', '2026-08-18T17:00:00Z')],
      openBreaks: [brk('b1', 's1', '2026-08-18T13:00:00Z')],
    });
    expect(out[0]!.detail).toContain('Pay is unaffected');
  });

  it('does NOT flag a break open on a shift that is still open — that is just lunch', () => {
    const out = run({
      shifts: [shift('s1', '2026-08-18T12:00:00Z', null)],
      openBreaks: [brk('b1', 's1', '2026-08-18T17:45:00Z')],
    });
    expect(out).toEqual([]);
  });
});

describe('forgotten clock-out', () => {
  it('flags a shift left open from an earlier ET day', () => {
    const out = run({ shifts: [shift('s1', '2026-08-17T14:00:00Z', null)] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'forgotten_clock_out', shiftId: 's1', rowId: null });
  });

  it('points at the midnight cron, because that is what should have caught it', () => {
    const out = run({ shifts: [shift('s1', '2026-08-17T14:00:00Z', null)] });
    expect(out[0]!.detail).toContain('midnight-close cron');
  });

  it("does not flag today's still-open shift", () => {
    const out = run({ shifts: [shift('s1', '2026-08-18T12:00:00Z', null)] });
    expect(out).toEqual([]);
  });

  it('judges the day in ET, not UTC', () => {
    // 2026-08-18T03:30Z is still 2026-08-17 in ET, so relative to the 18th it IS
    // an earlier day. A UTC comparison would call it today and stay silent.
    const out = run({ shifts: [shift('s1', '2026-08-18T03:30:00Z', null)] });
    expect(out.map((e) => e.type)).toContain('forgotten_clock_out');
  });
});

describe('stale open segment (the missed-tap case)', () => {
  it('flags an open segment past the idle gap on a still-open shift', () => {
    const out = run({
      shifts: [shift('s1', '2026-08-18T00:00:00Z', null)],
      openSegments: [seg('g1', 's1', '2026-08-18T00:30:00Z')], // 17.5h ago
      staleSegmentHours: DEFAULT_STALE_SEGMENT_HOURS,
    });
    expect(out.map((e) => e.type)).toContain('stale_open_segment');
  });

  it('leaves a recent segment alone', () => {
    const out = run({
      shifts: [shift('s1', '2026-08-18T12:00:00Z', null)],
      openSegments: [seg('g1', 's1', '2026-08-18T17:00:00Z')], // 1h ago
    });
    expect(out).toEqual([]);
  });

  it('honours a custom idle gap', () => {
    const input = {
      shifts: [shift('s1', '2026-08-18T12:00:00Z', null)],
      openSegments: [seg('g1', 's1', '2026-08-18T15:00:00Z')], // 3h ago
    };
    expect(run({ ...input, staleSegmentHours: 12 })).toEqual([]);
    expect(run({ ...input, staleSegmentHours: 2 }).map((e) => e.type)).toContain(
      'stale_open_segment',
    );
  });

  it('does not double-report a stale segment that is ALSO on a closed shift', () => {
    // A closed shift takes the orphan branch and is skipped by the stale branch,
    // so one problem produces one row rather than two.
    const out = run({
      shifts: [shift('s1', '2026-08-16T12:00:00Z', '2026-08-16T20:00:00Z')],
      openSegments: [seg('g1', 's1', '2026-08-16T13:00:00Z')],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('open_segment_on_closed_shift');
  });
});

describe('robustness', () => {
  it('flags an unparseable timestamp rather than silently ignoring the row', () => {
    expect(run({ shifts: [shift('s1', 'not-a-date', null)] }).map((e) => e.type)).toContain(
      'forgotten_clock_out',
    );
    expect(
      run({
        shifts: [shift('s1', '2026-08-18T12:00:00Z', null)],
        openSegments: [seg('g1', 's1', 'not-a-date')],
      }).map((e) => e.type),
    ).toContain('stale_open_segment');
  });

  it('ignores a child row whose shift is missing entirely, rather than crashing', () => {
    expect(run({ openBreaks: [brk('b1', 'ghost', '2026-08-18T13:00:00Z')] })).toEqual([]);
  });

  it('returns nothing when everything is healthy', () => {
    const out = run({
      shifts: [shift('s1', '2026-08-18T12:00:00Z', null), shift('s2', '2026-08-18T09:00:00Z', '2026-08-18T16:00:00Z')],
      openSegments: [seg('g1', 's1', '2026-08-18T17:30:00Z')],
    });
    expect(out).toEqual([]);
  });

  it('reports several distinct problems at once', () => {
    const out = run({
      shifts: [
        shift('s1', '2026-08-18T12:00:00Z', '2026-08-18T17:00:00Z'),
        shift('s2', '2026-08-16T12:00:00Z', null),
      ],
      openBreaks: [brk('b1', 's1', '2026-08-18T13:00:00Z')],
    });
    expect(out.map((e) => e.type).sort()).toEqual([
      'forgotten_clock_out',
      'open_break_on_closed_shift',
    ]);
  });
});
