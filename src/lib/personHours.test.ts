import { describe, expect, it } from 'vitest';
import {
  attributeAuditRows,
  splitPaidHours,
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

  it('leaves a future-dated shift out of a range, the way the summary table does', () => {
    // No such row can exist today: the manual routes refuse a future
    // timestamp and a live clock-in cannot be ahead of now. The bound is
    // here so the two modules cannot silently diverge if one ever appears,
    // because this page and the summary row beside it must never quote
    // different totals for the same shift.
    const future = shift({
      id: 'future',
      clockInAt: '2026-09-20T16:00:00Z',
      clockOutAt: '2026-09-20T17:00:00Z',
    });
    const ranged = groupPersonDays([future], [], rangeFromDay('30', NOW), NOW);
    expect(ranged.shiftCount).toBe(0);
    expect(ranged.totalSeconds).toBe(0);

    const summary = summarizeHours(
      [{ id: 'p', displayName: 'P', active: true, isOffice: true }],
      [{ ...future, crewMemberId: 'p' }],
      [],
      NOW,
    );
    expect(summary[0]!.last30Seconds).toBe(0);

    // All time has no bounds at either end, so it still shows the row rather
    // than hiding a real record nobody could then investigate.
    const all = groupPersonDays([future], [], rangeFromDay('all', NOW), NOW);
    expect(all.shiftCount).toBe(1);
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

  // This test DID only pin an outcome, back when the range had a low bound
  // only: 'unknown' sorts after every YYYY-MM-DD string, so it survived
  // `day < fromDay` whether or not the guard existed. Adding the upper bound
  // (`day > todayKey`) for cross-module agreement inverted that — 'unknown'
  // is now greater than today's key too, so the `day !== 'unknown'` guard
  // became load-bearing and a probe that removes it fails this test. Kept as
  // a record of why the guard is not decorative.
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


describe('attributeAuditRows', () => {
  const row = (over: Record<string, unknown>) => ({
    id: String(over.id),
    actor: 'Ann (ann@x)',
    created_at: String(over.created_at),
    action: String(over.action),
    detail: (over.detail ?? {}) as Record<string, unknown>,
  });

  it('keeps a removal-called-off entry that arrives BEFORE the row naming its shift', () => {
    // Newest first, the order the query returns. The abort is newer than the
    // void it corrects, and carries no crewMemberId — only a shift id. A
    // single pass would classify it as belonging to nobody and drop it,
    // leaving the false "Shift removed" claim standing alone.
    const out = attributeAuditRows(
      [
        row({
          id: 'abort',
          created_at: '2026-09-01T12:00:05Z',
          action: 'shift-manual-void-aborted',
          detail: { shiftId: 's1', reason: 'edit-race' },
        }),
        row({
          id: 'void',
          created_at: '2026-09-01T12:00:00Z',
          action: 'shift-manual-void',
          detail: { shiftId: 's1', crewMemberId: 'p', before: { clock_in_at: 'x' } },
        }),
      ],
      'p',
      [], // the shift is already gone, so it is not in the live shift list
    );
    expect(out.entries.map((e) => e.id)).toEqual(['abort', 'void']);
    expect(out.partial).toBe(false);
  });

  it('says the trail is partial when a called-off removal names no shift it can place', () => {
    const out = attributeAuditRows(
      [
        row({
          id: 'abort',
          created_at: '2026-09-01T12:00:05Z',
          action: 'shift-manual-void-aborted',
          detail: { shiftId: 'someone-elses-shift', reason: 'edit-race' },
        }),
      ],
      'p',
      ['s1'],
    );
    expect(out.entries).toHaveLength(0);
    expect(out.partial).toBe(true);
  });

  it('takes another person’s rows out, and never reports that as partial', () => {
    const out = attributeAuditRows(
      [
        row({ id: 'mine', created_at: '2026-09-01T12:00:00Z', action: 'shift-manual-edit', detail: { shiftId: 's1', crewMemberId: 'p' } }),
        row({ id: 'theirs', created_at: '2026-09-01T13:00:00Z', action: 'shift-manual-edit', detail: { shiftId: 's9', crewMemberId: 'other' } }),
      ],
      'p',
      [],
    );
    expect(out.entries.map((e) => e.id)).toEqual(['mine']);
    expect(out.partial).toBe(false);
  });

  it('places an abort against a shift the person still has', () => {
    const out = attributeAuditRows(
      [row({ id: 'abort', created_at: '2026-09-01T12:00:00Z', action: 'shift-manual-void-aborted', detail: { shiftId: 's1', reason: 'delete-failed' } })],
      'p',
      ['s1'],
    );
    expect(out.entries.map((e) => e.id)).toEqual(['abort']);
    expect(out.partial).toBe(false);
  });

  it('returns the trail newest first, so a correction sits above what it corrects', () => {
    const out = attributeAuditRows(
      [
        row({ id: 'older', created_at: '2026-08-01T00:00:00Z', action: 'shift-manual-create', detail: { shiftId: 's1', crewMemberId: 'p' } }),
        row({ id: 'newer', created_at: '2026-09-01T00:00:00Z', action: 'shift-manual-edit', detail: { shiftId: 's1', crewMemberId: 'p' } }),
      ],
      'p',
      [],
    );
    expect(out.entries.map((e) => e.id)).toEqual(['newer', 'older']);
  });

  it('breaks a same-millisecond tie by id, so a correction cannot sort below its claim', () => {
    // The two source lists are concatenated (this person's rows first, then
    // the aborts), so on a pure timestamp sort an abort written in the same
    // millisecond as the void it corrects would land underneath it. The
    // query asks for created_at desc, id desc; this keeps that order.
    const at = '2026-09-01T12:00:00.000Z';
    const out = attributeAuditRows(
      [
        row({ id: 'b-void', created_at: at, action: 'shift-manual-void', detail: { shiftId: 's1', crewMemberId: 'p' } }),
        row({ id: 'c-abort', created_at: at, action: 'shift-manual-void-aborted', detail: { shiftId: 's1', reason: 'edit-race' } }),
      ],
      'p',
      [],
    );
    expect(out.entries.map((e) => e.id)).toEqual(['c-abort', 'b-void']);
  });

  it('ignores activity rows that are not manual shift writes', () => {
    const out = attributeAuditRows(
      [row({ id: 'x', created_at: '2026-09-01T00:00:00Z', action: 'handled', detail: { crewMemberId: 'p' } })],
      'p',
      [],
    );
    expect(out.entries).toHaveLength(0);
  });
});

describe('splitPaidHours', () => {
  const row = (over: Partial<{ id: string; clockOutAt: string | null; settledSeconds: number; paidSeconds: number }>) => ({
    id: 'x',
    clockInAt: '2026-09-01T13:00:00.000Z',
    clockOutAt: '2026-09-01T21:00:00.000Z' as string | null,
    source: 'office',
    closeSource: 'office',
    manualBy: null,
    paidSeconds: 8 * H,
    breakSeconds: 0,
    removable: false,
    settlementId: null as string | null,
    settledSeconds: 0,
    ...over,
  });

  it('separates settled hours from hours nobody has paid for yet', () => {
    const split = splitPaidHours([
      {
        day: '2026-09-01',
        paidSeconds: 13 * H,
        shifts: [row({ id: 'a', settledSeconds: 8 * H }), row({ id: 'b', paidSeconds: 5 * H })],
      },
    ]);
    expect(split.paidSeconds).toBe(8 * H);
    expect(split.paidCount).toBe(1);
    expect(split.unpaidSeconds).toBe(5 * H);
    expect(split.unpaidCount).toBe(1);
    expect(split.openSeconds).toBe(0);
  });

  it('splits a PART-paid shift across both sides, and counts it in both', () => {
    // The rollover case: $180 covered 3h 48m of a 4h 22m shift, so the same
    // shift is both money already received and time still owed. Counting it
    // on one side only would make one of the two totals a lie.
    const split = splitPaidHours([
      { day: '2026-09-01', paidSeconds: 8 * H, shifts: [row({ settledSeconds: 3 * H })] },
    ]);
    expect(split.paidSeconds).toBe(3 * H);
    expect(split.unpaidSeconds).toBe(5 * H);
    expect(split.paidCount).toBe(1);
    expect(split.unpaidCount).toBe(1);
  });

  it('never lets a settled figure exceed the shift it belongs to', () => {
    // The database refuses lines that sum past a shift's hours, so this can
    // only be a broken read — and it must not render as negative time owed.
    const split = splitPaidHours([
      { day: '2026-09-01', paidSeconds: 4 * H, shifts: [row({ paidSeconds: 4 * H, settledSeconds: 9 * H })] },
    ]);
    expect(split.paidSeconds).toBe(4 * H);
    expect(split.unpaidSeconds).toBe(0);
  });

  it('puts a shift that is still running in NEITHER bucket', () => {
    // Calling time you are still working "unpaid" invites it to be expected
    // in this week's payment; it cannot have been paid either.
    const split = splitPaidHours([
      { day: '2026-09-01', paidSeconds: 2 * H, shifts: [row({ clockOutAt: null, paidSeconds: 2 * H })] },
    ]);
    expect(split.openSeconds).toBe(2 * H);
    expect(split.unpaidSeconds).toBe(0);
    expect(split.paidSeconds).toBe(0);
    expect(split.unpaidCount).toBe(0);
  });

  it('adds up across days, and returns zeroes for an empty range', () => {
    const day = (id: string, settledSeconds: number) => ({
      day: '2026-09-0' + id,
      paidSeconds: 8 * H,
      shifts: [row({ id, settledSeconds })],
    });
    const split = splitPaidHours([day('1', 8 * H), day('2', 0), day('3', 0)]);
    expect(split.paidSeconds).toBe(8 * H);
    expect(split.unpaidSeconds).toBe(16 * H);
    expect(splitPaidHours([])).toEqual({
      paidSeconds: 0,
      paidCount: 0,
      unpaidSeconds: 0,
      unpaidCount: 0,
      openSeconds: 0,
    });
  });
});
