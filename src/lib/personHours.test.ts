import { describe, expect, it } from 'vitest';
import {
  groupPersonDays,
  isRangeKey,
  rangeFromDay,
  rangeLabel,
  toAuditEntry,
  RANGE_KEYS,
} from './personHours';
import { summarizeHours } from './hoursSummary';

// 2026-09-02 10:00 ET = 14:00Z. DST in force, ET = UTC-4.
const NOW = '2026-09-02T14:00:00.000Z';
const H = 3600;

type Shift = Parameters<typeof groupPersonDays>[0][number];

function shift(over: Partial<Shift> & { id: string; clockInAt: string }): Shift {
  return {
    clockOutAt: null,
    source: 'office',
    closeSource: null,
    manualBy: null,
    ...over,
  };
}

describe('groupPersonDays', () => {
  it('groups shifts by ET day, newest day first and newest shift first inside a day', () => {
    const out = groupPersonDays(
      [
        shift({ id: 'a', clockInAt: '2026-09-01T13:00:00Z', clockOutAt: '2026-09-01T15:00:00Z' }),
        shift({ id: 'b', clockInAt: '2026-09-01T18:00:00Z', clockOutAt: '2026-09-01T19:00:00Z' }),
        shift({ id: 'c', clockInAt: '2026-08-30T13:00:00Z', clockOutAt: '2026-08-30T14:00:00Z' }),
      ],
      [],
      null,
      NOW,
    );
    expect(out.days.map((d) => d.day)).toEqual(['2026-09-01', '2026-08-30']);
    expect(out.days[0]!.shifts.map((s) => s.id)).toEqual(['b', 'a']);
    expect(out.days[0]!.paidSeconds).toBe(3 * H);
    expect(out.totalSeconds).toBe(4 * H);
    expect(out.shiftCount).toBe(3);
  });

  it('subtracts breaks from the shift and reports the break time separately', () => {
    const out = groupPersonDays(
      [shift({ id: 'a', clockInAt: '2026-09-01T13:00:00Z', clockOutAt: '2026-09-01T15:00:00Z' })],
      [{ shiftId: 'a', startedAt: '2026-09-01T13:30:00Z', endedAt: '2026-09-01T14:00:00Z' }],
      null,
      NOW,
    );
    const s = out.days[0]!.shifts[0]!;
    expect(s.paidSeconds).toBe(90 * 60);
    expect(s.breakSeconds).toBe(30 * 60);
    expect(out.totalSeconds).toBe(90 * 60);
  });

  it('subtracts EVERY break on one shift, not just the first', () => {
    // A probe that emptied the per-shift break list still passed while each
    // shift had at most one break, because the grouping map happened to end
    // up right either way. Two breaks on one shift is what actually tests
    // that the list is accumulated rather than replaced.
    const out = groupPersonDays(
      [shift({ id: 'a', clockInAt: '2026-09-01T13:00:00Z', clockOutAt: '2026-09-01T17:00:00Z' })],
      [
        { shiftId: 'a', startedAt: '2026-09-01T13:30:00Z', endedAt: '2026-09-01T14:00:00Z' },
        { shiftId: 'a', startedAt: '2026-09-01T15:00:00Z', endedAt: '2026-09-01T15:45:00Z' },
      ],
      null,
      NOW,
    );
    const s = out.days[0]!.shifts[0]!;
    expect(s.breakSeconds).toBe(75 * 60);
    expect(s.paidSeconds).toBe(4 * H - 75 * 60);
  });

  it('gives a break to the shift it belongs to and no other', () => {
    const out = groupPersonDays(
      [
        shift({ id: 'a', clockInAt: '2026-09-01T13:00:00Z', clockOutAt: '2026-09-01T15:00:00Z' }),
        shift({ id: 'b', clockInAt: '2026-09-01T16:00:00Z', clockOutAt: '2026-09-01T18:00:00Z' }),
      ],
      [{ shiftId: 'b', startedAt: '2026-09-01T16:30:00Z', endedAt: '2026-09-01T17:00:00Z' }],
      null,
      NOW,
    );
    const byId = new Map(out.days[0]!.shifts.map((s) => [s.id, s]));
    expect(byId.get('a')!.breakSeconds).toBe(0);
    expect(byId.get('b')!.breakSeconds).toBe(30 * 60);
  });

  it('keeps an overnight shift whole on the day it started', () => {
    // Sep 1 22:00 ET to Sep 2 02:00 ET.
    const out = groupPersonDays(
      [shift({ id: 'a', clockInAt: '2026-09-02T02:00:00Z', clockOutAt: '2026-09-02T06:00:00Z' })],
      [],
      null,
      NOW,
    );
    expect(out.days).toHaveLength(1);
    expect(out.days[0]!.day).toBe('2026-09-01');
    expect(out.days[0]!.paidSeconds).toBe(4 * H);
  });

  it('drops days older than the range and keeps the range boundary day itself', () => {
    const on = (id: string, day: string) =>
      shift({ id, clockInAt: `${day}T16:00:00Z`, clockOutAt: `${day}T17:00:00Z` });
    const shifts = [
      on('today', '2026-09-02'),
      on('boundary', '2026-08-27'), // the oldest day a 7-day window includes
      on('older', '2026-08-26'),
    ];
    const out = groupPersonDays(shifts, [], rangeFromDay('7', NOW), NOW);
    expect(out.days.map((d) => d.day)).toEqual(['2026-09-02', '2026-08-27']);
    expect(out.shiftCount).toBe(2);
    expect(out.totalSeconds).toBe(2 * H);
  });

  it('counts an open shift up to now and reports it', () => {
    const out = groupPersonDays(
      [shift({ id: 'a', clockInAt: '2026-09-02T12:00:00Z', source: 'telegram' })],
      [],
      null,
      NOW,
    );
    expect(out.openShift).toEqual({ clockInAt: '2026-09-02T12:00:00Z', source: 'telegram' });
    expect(out.totalSeconds).toBe(2 * H);
  });

  it('reports midnight auto-closes separately while leaving them in the totals', () => {
    const out = groupPersonDays(
      [
        shift({ id: 'a', clockInAt: '2026-09-01T13:00:00Z', clockOutAt: '2026-09-01T15:00:00Z' }),
        shift({
          id: 'b',
          clockInAt: '2026-08-31T13:00:00Z',
          clockOutAt: '2026-09-01T04:00:00Z',
          closeSource: 'system',
        }),
        ],
      [],
      null,
      NOW,
    );
    expect(out.autoClosed.count).toBe(1);
    expect(out.autoClosed.seconds).toBe(15 * H);
    expect(out.totalSeconds).toBe(17 * H);
  });

  it('marks only an office-TYPED row removable, mirroring the server guard', () => {
    const out = groupPersonDays(
      [
        shift({ id: 'typed', clockInAt: '2026-09-01T13:00:00Z', clockOutAt: '2026-09-01T14:00:00Z', source: 'office', manualBy: 'Ann (ann@x)' }),
        shift({ id: 'own-web', clockInAt: '2026-09-01T15:00:00Z', clockOutAt: '2026-09-01T16:00:00Z', source: 'office' }),
        shift({ id: 'bot', clockInAt: '2026-09-01T17:00:00Z', clockOutAt: '2026-09-01T18:00:00Z', source: 'telegram', manualBy: 'Ann (ann@x)' }),
      ],
      [],
      null,
      NOW,
    );
    const byId = new Map(out.days[0]!.shifts.map((s) => [s.id, s]));
    expect(byId.get('typed')!.removable).toBe(true);
    // The person's own web clock-in: source 'office' but nobody typed it.
    expect(byId.get('own-web')!.removable).toBe(false);
    // A hand-corrected bot punch is still the crew member's own record.
    expect(byId.get('bot')!.removable).toBe(false);
  });

  it('keeps a shift with an unreadable clock-in under an explicit unknown day', () => {
    const out = groupPersonDays([shift({ id: 'a', clockInAt: 'not-a-date' })], [], null, NOW);
    expect(out.days.map((d) => d.day)).toEqual(['unknown']);
    expect(out.shiftCount).toBe(1);
    expect(out.totalSeconds).toBe(0);
  });

  // NOTE, so nobody mistakes this for a pin on the `day !== 'unknown'` guard
  // in groupPersonDays: removing that guard alone does NOT fail this test,
  // because 'unknown' also sorts after every YYYY-MM-DD string and so
  // survives the `day < fromDay` comparison anyway. The guard is kept as the
  // stated intent (it would still hold if the key format ever changed); this
  // test pins the OUTCOME, which two independent things currently protect.
  it('keeps an unreadable clock-in even when a range is set, rather than filtering it away', () => {
    const out = groupPersonDays(
      [shift({ id: 'a', clockInAt: 'not-a-date' })],
      [],
      rangeFromDay('7', NOW),
      NOW,
    );
    expect(out.days.map((d) => d.day)).toEqual(['unknown']);
  });

  // The two screens must never disagree about the same shift. This asserts
  // the phase-1 summary and the phase-2 detail bucket identical input the
  // same way, rather than trusting two copies of the rule to stay in step.
  it('totals the same hours as the summary table for the same shifts', () => {
    const raw = [
      { id: 'a', clockInAt: '2026-09-02T02:00:00Z', clockOutAt: '2026-09-02T06:00:00Z' },
      { id: 'b', clockInAt: '2026-08-28T16:00:00Z', clockOutAt: '2026-08-28T18:30:00Z' },
      { id: 'c', clockInAt: '2026-09-02T12:00:00Z', clockOutAt: null },
    ];
    const breaks = [{ shiftId: 'b', startedAt: '2026-08-28T17:00:00Z', endedAt: '2026-08-28T17:20:00Z' }];

    const detail = groupPersonDays(
      raw.map((r) => ({ ...r, source: 'office', closeSource: null, manualBy: null })),
      breaks,
      rangeFromDay('7', NOW),
      NOW,
    );
    const summary = summarizeHours(
      [{ id: 'p', displayName: 'P', active: true, isOffice: true }],
      raw.map((r) => ({ ...r, crewMemberId: 'p', source: 'office', closeSource: null })),
      breaks,
      NOW,
    );
    expect(detail.totalSeconds).toBe(summary[0]!.last7Seconds);
  });
});

describe('rangeFromDay', () => {
  it('counts back inclusively, so a 7-day window starts six days before today', () => {
    expect(rangeFromDay('7', NOW)).toBe('2026-08-27');
    expect(rangeFromDay('30', NOW)).toBe('2026-08-04');
    expect(rangeFromDay('90', NOW)).toBe('2026-06-05');
  });

  it('has no floor for all time', () => {
    expect(rangeFromDay('all', NOW)).toBeNull();
  });
});

describe('isRangeKey', () => {
  it('accepts exactly the keys the page offers and nothing else', () => {
    for (const key of RANGE_KEYS) expect(isRangeKey(key)).toBe(true);
    for (const junk of ['365', '', 'ALL', '7 ', 7, null, undefined, {}]) {
      expect(isRangeKey(junk)).toBe(false);
    }
  });

  it('names every range it accepts', () => {
    for (const key of RANGE_KEYS) expect(rangeLabel(key)).toMatch(/\S/);
    expect(rangeLabel('all')).toBe('All time');
    expect(rangeLabel('7')).toBe('Last 7 days');
  });
});

describe('toAuditEntry', () => {
  const base = {
    id: 'row-1',
    actor: 'Ann (ann@x)',
    created_at: '2026-09-01T14:00:00Z',
  };

  it('reads the before and after times off an edit entry', () => {
    const e = toAuditEntry({
      ...base,
      action: 'shift-manual-edit',
      detail: {
        shiftId: 's1',
        crewMemberId: 'p',
        before: { clock_in_at: '2026-09-01T12:00:00Z', clock_out_at: null },
        after: { clock_in_at: '2026-09-01T12:00:00Z', clock_out_at: '2026-09-01T20:00:00Z' },
      },
    });
    expect(e?.action).toBe('shift-manual-edit');
    expect(e?.shiftId).toBe('s1');
    expect(e?.before).toEqual({ clockInAt: '2026-09-01T12:00:00Z', clockOutAt: null });
    expect(e?.after?.clockOutAt).toBe('2026-09-01T20:00:00Z');
  });

  it('reads a void as a before with no after, which is what makes it the only copy', () => {
    const e = toAuditEntry({
      ...base,
      action: 'shift-manual-void',
      detail: {
        shiftId: 's1',
        crewMemberId: 'p',
        before: { clock_in_at: '2026-09-01T12:00:00Z', clock_out_at: '2026-09-01T20:00:00Z' },
        after: null,
      },
    });
    expect(e?.before?.clockInAt).toBe('2026-09-01T12:00:00Z');
    expect(e?.after).toBeNull();
  });

  it('carries the reason off an aborted void', () => {
    const e = toAuditEntry({
      ...base,
      action: 'shift-manual-void-aborted',
      detail: { shiftId: 's1', reason: 'edit-race', note: 'The shift was NOT removed.' },
    });
    expect(e?.reason).toBe('edit-race');
    expect(e?.shiftId).toBe('s1');
  });

  it('refuses an action that is not a manual shift write', () => {
    expect(toAuditEntry({ ...base, action: 'handled', detail: {} })).toBeNull();
    expect(toAuditEntry({ ...base, action: 'ingested', detail: null })).toBeNull();
  });

  it('survives a detail with nothing in it rather than throwing on a payroll page', () => {
    const e = toAuditEntry({ ...base, action: 'shift-manual-create', detail: null });
    expect(e?.shiftId).toBeNull();
    expect(e?.before).toBeNull();
    expect(e?.after).toBeNull();
  });

  it('never leaves the actor blank, because an unattributed payroll edit reads as nobody', () => {
    const e = toAuditEntry({ ...base, actor: '   ', action: 'shift-manual-edit', detail: {} });
    expect(e?.actor).toBe('unknown');
    const noActor = toAuditEntry({ ...base, actor: null, action: 'shift-manual-edit', detail: {} });
    expect(noActor?.actor).toBe('unknown');
  });
});
