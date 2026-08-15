import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Source = 'pwa' | 'telegram' | 'office' | 'system';
type DbError = { code?: string; message: string };

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
};

type SegRow = {
  id: string;
  shift_id: string;
  crew_member_id: string;
  job_id: string;
  arrived_at: string;
  departed_at: string | null;
  entry_kind: 'install' | 'rework' | 'non_billable';
  stoppage_reason: string | null;
  source: Source;
  end_source: Source | null;
  auto_closed: boolean;
  approved_by: string | null;
  approved_at: string | null;
  device_time: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const OPEN_SHIFT: ShiftRow = {
  id: 'shift-1',
  crew_member_id: 'crew-1',
  clock_in_at: '2026-08-12T12:00:00.000Z',
  clock_out_at: null,
};
const CLOSED_SHIFT: ShiftRow = {
  id: 'shift-closed',
  crew_member_id: 'crew-2',
  clock_in_at: '2026-08-12T08:00:00.000Z',
  clock_out_at: '2026-08-12T10:00:00.000Z',
};

const OPEN_SEG: SegRow = {
  id: 'seg-open',
  shift_id: 'shift-1',
  crew_member_id: 'crew-1',
  job_id: 'job-a',
  arrived_at: '2026-08-12T13:00:00.000Z',
  departed_at: null,
  entry_kind: 'install',
  stoppage_reason: null,
  source: 'telegram',
  end_source: null,
  auto_closed: false,
  approved_by: null,
  approved_at: null,
  device_time: null,
  created_at: '2026-08-12T13:00:00.000Z',
  updated_at: '2026-08-12T13:00:00.000Z',
};

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      shifts: [] as ShiftRow[],
      segments: [] as SegRow[],
      inserted: [] as Record<string, unknown>[],
      updated: [] as Record<string, unknown>[],
      insertRaceRow: null as SegRow | null,
      selectError: null as DbError | null,
      updateError: null as DbError | null,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));

function makeInserted(p: Record<string, unknown>): SegRow {
  const now = new Date().toISOString();
  return {
    id: `gen-${stateRef.current.segments.length + 1}`,
    shift_id: String(p.shift_id),
    crew_member_id: String(p.crew_member_id),
    job_id: String(p.job_id),
    arrived_at: now,
    departed_at: null,
    entry_kind: (p.entry_kind as SegRow['entry_kind']) ?? 'install',
    stoppage_reason: null,
    source: p.source as Source,
    end_source: null,
    auto_closed: false,
    approved_by: null,
    approved_at: null,
    device_time: null,
    created_at: now,
    updated_at: now,
  };
}

function makeDb() {
  return {
    from(table: string) {
      if (table !== 'shifts' && table !== 'job_segments') {
        throw new Error(`jobSegments.test.ts: unexpected table ${table}`);
      }
      const isSeg = table === 'job_segments';
      const source = () =>
        (isSeg ? stateRef.current.segments : stateRef.current.shifts) as Array<
          Record<string, unknown>
        >;

      let filtered = [...source()];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          filtered = filtered.filter((r) => r[c] === v);
          return b;
        },
        is: (c: string, v: unknown) => {
          if (v === null) filtered = filtered.filter((r) => r[c] === null);
          return b;
        },
        order: (c: string) => {
          filtered = [...filtered].sort((x, y) => String(x[c]).localeCompare(String(y[c])));
          return b;
        },
        maybeSingle: () =>
          Promise.resolve({
            data: stateRef.current.selectError ? null : (filtered[0] ?? null),
            error: stateRef.current.selectError,
          }),
        then: (resolve: (v: { data: unknown; error: DbError | null }) => unknown) =>
          resolve({
            data: stateRef.current.selectError ? null : filtered,
            error: stateRef.current.selectError,
          }),
        insert: (p: Record<string, unknown>) => {
          stateRef.current.inserted.push(p);
          if (stateRef.current.insertRaceRow) {
            const w = stateRef.current.insertRaceRow;
            stateRef.current.insertRaceRow = null;
            stateRef.current.segments.push(w);
            return {
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: null,
                    error: {
                      code: '23505',
                      message:
                        'duplicate key value violates unique constraint "job_segments_one_open_per_shift"',
                    } as DbError,
                  }),
              }),
            };
          }
          const row = makeInserted(p);
          stateRef.current.segments.push(row);
          return {
            select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
          };
        },
        update: (p: Record<string, unknown>) => {
          const f: Record<string, unknown> = {};
          const ub = {
            eq: (c: string, v: unknown) => {
              f[c] = v;
              return ub;
            },
            is: (c: string, v: unknown) => {
              f[c] = v;
              return ub;
            },
            select: () => ({
              maybeSingle: () => {
                if (stateRef.current.updateError) {
                  return Promise.resolve({ data: null, error: stateRef.current.updateError });
                }
                const rows = source();
                const i = rows.findIndex((r) =>
                  Object.entries(f).every(([k, v]) => r[k] === v),
                );
                if (i === -1) return Promise.resolve({ data: null, error: null });
                stateRef.current.updated.push(p);
                const next = { ...rows[i], ...p, updated_at: new Date().toISOString() };
                rows[i] = next;
                return Promise.resolve({ data: next, error: null });
              },
            }),
          };
          return ub;
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-12T16:00:00.000Z'));
  stateRef.current = {
    shifts: [{ ...OPEN_SHIFT }, { ...CLOSED_SHIFT }],
    segments: [{ ...OPEN_SEG }],
    inserted: [],
    updated: [],
    insertRaceRow: null,
    selectError: null,
    updateError: null,
  };
  dbRef.current = makeDb();
});

afterEach(() => vi.useRealTimers());

import {
  arriveAtJob,
  closeOpenSegmentForShift,
  departFromJob,
  getOpenSegment,
  jobSecondsByJob,
  jobSecondsForShift,
  listSegments,
  staleOpenSegments,
  travelSecondsForShift,
} from './jobSegments';

// ---------------------------------------------------------------------------
// The money math. Job seconds drive efficiency, which drives the P4P pool.
// ---------------------------------------------------------------------------

const shift = (i: string, o: string | null) => ({ clockInAt: i, clockOutAt: o });
const seg = (jobId: string, a: string, d: string | null) => ({
  jobId,
  arrivedAt: a,
  departedAt: d,
});
const brk = (s: string, e: string | null) => ({ startedAt: s, endedAt: e });
const T = (hhmm: string) => `2026-08-12T${hhmm}:00.000Z`;

const DAY = shift(T('08:00'), T('16:00')); // 8h envelope

describe('jobSecondsForShift', () => {
  it('counts a simple segment', () => {
    expect(jobSecondsForShift(DAY, [seg('job-a', T('09:00'), T('12:00'))], [])).toBe(3 * 3600);
  });

  it('SUBTRACTS a break that falls inside the segment — breaks pause job time', () => {
    // The rule that matters most: 9:00-17:00 with a 30 minute lunch is 7.5
    // hours on the job, not 8.
    expect(
      jobSecondsForShift(
        DAY,
        [seg('job-a', T('09:00'), T('15:00'))],
        [brk(T('12:00'), T('12:30'))],
      ),
    ).toBe(6 * 3600 - 30 * 60);
  });

  it('ignores a break that falls outside the segment', () => {
    expect(
      jobSecondsForShift(
        DAY,
        [seg('job-a', T('09:00'), T('11:00'))],
        [brk(T('12:00'), T('12:30'))],
      ),
    ).toBe(2 * 3600);
  });

  it('merges overlapping segments so the overlap is not counted twice', () => {
    // Double-counting here would overstate actual hours, making the crew look
    // slower than they were and cutting the efficiency they are paid on.
    expect(
      jobSecondsForShift(
        DAY,
        [seg('job-a', T('09:00'), T('12:00')), seg('job-a', T('11:00'), T('13:00'))],
        [],
      ),
    ).toBe(4 * 3600);
  });

  it('clips a segment to the shift envelope', () => {
    expect(jobSecondsForShift(DAY, [seg('job-a', T('07:00'), T('17:00'))], [])).toBe(8 * 3600);
  });

  it('runs an open segment to now', () => {
    // System time is 16:00Z; the shift is open.
    expect(jobSecondsForShift(shift(T('08:00'), null), [seg('job-a', T('14:00'), null)], [])).toBe(
      2 * 3600,
    );
  });

  it('never goes negative when breaks swallow the whole segment', () => {
    expect(
      jobSecondsForShift(
        DAY,
        [seg('job-a', T('12:00'), T('12:30'))],
        [brk(T('11:00'), T('14:00'))],
      ),
    ).toBe(0);
  });

  it('returns 0 for a shift with no segments', () => {
    expect(jobSecondsForShift(DAY, [], [brk(T('12:00'), T('12:30'))])).toBe(0);
  });
});

describe('jobSecondsByJob', () => {
  it('splits time per job and does not leak one job into another', () => {
    const byJob = jobSecondsByJob(
      DAY,
      [seg('job-a', T('09:00'), T('11:00')), seg('job-b', T('13:00'), T('15:00'))],
      [],
    );
    expect(byJob).toEqual({ 'job-a': 2 * 3600, 'job-b': 2 * 3600 });
  });

  it('subtracts a break from the job it actually overlaps, not the other', () => {
    const byJob = jobSecondsByJob(
      DAY,
      [seg('job-a', T('09:00'), T('11:00')), seg('job-b', T('13:00'), T('15:00'))],
      [brk(T('09:30'), T('10:00'))],
    );
    expect(byJob['job-a']).toBe(2 * 3600 - 30 * 60);
    expect(byJob['job-b']).toBe(2 * 3600);
  });

  it('merges a job’s own overlapping segments before totalling', () => {
    const byJob = jobSecondsByJob(
      DAY,
      [seg('job-a', T('09:00'), T('12:00')), seg('job-a', T('11:00'), T('13:00'))],
      [],
    );
    expect(byJob['job-a']).toBe(4 * 3600);
  });

  it('per-job totals sum to the shift total when segments do not overlap', () => {
    const segs = [seg('job-a', T('09:00'), T('11:00')), seg('job-b', T('13:00'), T('15:00'))];
    const breaks = [brk(T('09:30'), T('10:00'))];
    const byJob = jobSecondsByJob(DAY, segs, breaks);
    const sum = Object.values(byJob).reduce((a, b) => a + b, 0);
    expect(sum).toBe(jobSecondsForShift(DAY, segs, breaks));
  });
});

describe('travelSecondsForShift', () => {
  it('is the residual: paid day minus job time minus breaks', () => {
    // 8h day, 5h on jobs, 30m break -> 2.5h travel.
    expect(
      travelSecondsForShift(
        DAY,
        [seg('job-a', T('09:00'), T('12:00')), seg('job-b', T('13:00'), T('15:00'))],
        [brk(T('12:00'), T('12:30'))],
      ),
    ).toBe(2.5 * 3600);
  });

  it('is the whole day when nothing else is recorded', () => {
    expect(travelSecondsForShift(DAY, [], [])).toBe(8 * 3600);
  });

  it('never goes negative', () => {
    expect(
      travelSecondsForShift(DAY, [seg('job-a', T('08:00'), T('16:00'))], [brk(T('09:00'), T('10:00'))]),
    ).toBeGreaterThanOrEqual(0);
  });

  it('the four parts never over-account for the paid day', () => {
    const segs = [seg('job-a', T('09:00'), T('12:00'))];
    const breaks = [brk(T('12:00'), T('12:30'))];
    const total =
      jobSecondsForShift(DAY, segs, breaks) +
      travelSecondsForShift(DAY, segs, breaks) +
      30 * 60; // the break itself
    expect(total).toBeLessThanOrEqual(8 * 3600);
  });
});

describe('staleOpenSegments (missed-tap backstop)', () => {
  const s = (id: string, arrivedAt: string, departedAt: string | null) => ({
    id,
    arrivedAt,
    departedAt,
  });

  it('flags an open segment older than the idle gap', () => {
    // now = 16:00Z, gap = 4h -> a 09:00 arrival is stale.
    const stale = staleOpenSegments([s('a', T('09:00'), null)], 4 * 3600);
    expect(stale.map((x) => x.id)).toEqual(['a']);
  });

  it('leaves a recent open segment alone', () => {
    expect(staleOpenSegments([s('a', T('15:30'), null)], 4 * 3600)).toEqual([]);
  });

  it('never flags a closed segment, however old', () => {
    expect(staleOpenSegments([s('a', T('01:00'), T('02:00'))], 60)).toEqual([]);
  });

  it('flags an unparseable arrival, because that is its own data problem', () => {
    const stale = staleOpenSegments([s('a', 'not-a-date', null)], 4 * 3600);
    expect(stale.map((x) => x.id)).toEqual(['a']);
  });

  it('does not close anything — detection only', () => {
    const rows = [s('a', T('09:00'), null)];
    staleOpenSegments(rows, 60);
    expect(rows[0].departedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ledger writes.
// ---------------------------------------------------------------------------

describe('arriveAtJob', () => {
  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(arriveAtJob('shift-1', 'crew-1', 'job-a', 'pwa')).rejects.toThrow(
      'Supabase service role not configured',
    );
  });

  it('rejects an unknown shift', async () => {
    await expect(arriveAtJob('nope', 'crew-1', 'job-a', 'pwa')).rejects.toThrow(
      'arriveAtJob: no shift found for id nope',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it("rejects someone else's shift", async () => {
    await expect(arriveAtJob('shift-1', 'crew-2', 'job-a', 'pwa')).rejects.toThrow(
      'belongs to crew-1, not crew-2',
    );
  });

  it('rejects arriving on a closed shift', async () => {
    await expect(arriveAtJob('shift-closed', 'crew-2', 'job-a', 'pwa')).rejects.toThrow(
      'is already closed',
    );
  });

  it('opens a segment when nothing is running', async () => {
    stateRef.current.segments = [];
    await expect(arriveAtJob('shift-1', 'crew-1', 'job-a', 'pwa')).resolves.toMatchObject({
      jobId: 'job-a',
      arrivedAt: '2026-08-12T16:00:00.000Z',
      departedAt: null,
      entryKind: 'install',
    });
    expect(stateRef.current.inserted).toEqual([
      {
        shift_id: 'shift-1',
        crew_member_id: 'crew-1',
        job_id: 'job-a',
        source: 'pwa',
        entry_kind: 'install',
      },
    ]);
  });

  it('returns the running segment on a double-tap for the SAME job', async () => {
    await expect(arriveAtJob('shift-1', 'crew-1', 'job-a', 'pwa')).resolves.toMatchObject({
      id: 'seg-open',
      arrivedAt: '2026-08-12T13:00:00.000Z',
    });
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('REJECTS arriving at a different job while one is still open', async () => {
    // Otherwise two jobs could both be credited with the same minutes.
    await expect(arriveAtJob('shift-1', 'crew-1', 'job-b', 'pwa')).rejects.toThrow(
      'still on job job-a; depart it before arriving at job-b',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('recovers the winner when a concurrent double-tap trips the unique index', async () => {
    stateRef.current.segments = [];
    stateRef.current.insertRaceRow = { ...OPEN_SEG, id: 'seg-race' };
    await expect(arriveAtJob('shift-1', 'crew-1', 'job-a', 'pwa')).resolves.toMatchObject({
      id: 'seg-race',
    });
  });

  it('carries a non-default entry kind', async () => {
    stateRef.current.segments = [];
    await expect(
      arriveAtJob('shift-1', 'crew-1', 'job-a', 'office', 'rework'),
    ).resolves.toMatchObject({ entryKind: 'rework' });
  });
});

describe('departFromJob', () => {
  it('closes the segment with its reason', async () => {
    await expect(departFromJob('seg-open', 'crew-1', 'completed', 'office')).resolves.toMatchObject({
      departedAt: '2026-08-12T16:00:00.000Z',
      stoppageReason: 'completed',
      endSource: 'office',
      autoClosed: false,
    });
  });

  it('rejects an invalid stoppage reason before touching the row', async () => {
    await expect(
      departFromJob('seg-open', 'crew-1', 'finished' as never, 'office'),
    ).rejects.toThrow('invalid stoppage reason');
    expect(stateRef.current.updated).toEqual([]);
  });

  it('rejects an unknown segment', async () => {
    await expect(departFromJob('nope', 'crew-1', 'completed', 'office')).rejects.toThrow(
      'no segment found for id nope',
    );
  });

  it("rejects someone else's segment", async () => {
    await expect(departFromJob('seg-open', 'crew-2', 'completed', 'office')).rejects.toThrow(
      'belongs to crew-1, not crew-2',
    );
  });

  it('rejects re-departing rather than moving the recorded time', async () => {
    stateRef.current.segments = [
      { ...OPEN_SEG, departed_at: '2026-08-12T14:00:00.000Z', stoppage_reason: 'completed' },
    ];
    await expect(departFromJob('seg-open', 'crew-1', 'weather', 'office')).rejects.toThrow(
      'already departed',
    );
    expect(stateRef.current.segments[0].departed_at).toBe('2026-08-12T14:00:00.000Z');
  });
});

describe('closeOpenSegmentForShift', () => {
  it('closes at the punch time, flagged for review, reason "other" NOT "completed"', async () => {
    // A clock-out says the day ended, not that the job finished. Recording
    // `completed` would corrupt the budgeted-hours learning signal.
    await expect(
      closeOpenSegmentForShift('shift-1', '2026-08-12T16:00:00.000Z', 'office'),
    ).resolves.toMatchObject({
      departedAt: '2026-08-12T16:00:00.000Z',
      stoppageReason: 'other',
      autoClosed: true,
    });
  });

  it('returns null when nothing is running', async () => {
    stateRef.current.segments = [];
    await expect(
      closeOpenSegmentForShift('shift-1', '2026-08-12T16:00:00.000Z', 'office'),
    ).resolves.toBeNull();
    expect(stateRef.current.updated).toEqual([]);
  });

  it('is a no-op the second time, so a retried clock-out cannot move the time', async () => {
    await closeOpenSegmentForShift('shift-1', '2026-08-12T16:00:00.000Z', 'office');
    await expect(
      closeOpenSegmentForShift('shift-1', '2026-08-12T17:00:00.000Z', 'office'),
    ).resolves.toBeNull();
    expect(stateRef.current.segments[0].departed_at).toBe('2026-08-12T16:00:00.000Z');
  });
});

describe('reads and error handling', () => {
  it('getOpenSegment maps the row', async () => {
    await expect(getOpenSegment(' shift-1 ')).resolves.toMatchObject({
      id: 'seg-open',
      jobId: 'job-a',
    });
  });

  it('listSegments returns oldest-first', async () => {
    stateRef.current.segments = [
      { ...OPEN_SEG, id: 'late', arrived_at: T('15:00') },
      { ...OPEN_SEG, id: 'early', arrived_at: T('09:00'), departed_at: T('10:00') },
    ];
    const rows = await listSegments('shift-1');
    expect(rows.map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('getOpenSegment swallows a read error and reports nothing open', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      stateRef.current.selectError = { message: 'connection terminated' };
      await expect(getOpenSegment('shift-1')).resolves.toBeNull();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('arriveAtJob surfaces a shift-lookup error rather than opening blind', async () => {
    stateRef.current.selectError = { message: 'connection terminated' };
    await expect(arriveAtJob('shift-1', 'crew-1', 'job-a', 'pwa')).rejects.toThrow(
      'arriveAtJob: connection terminated',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('departFromJob surfaces an update error rather than reporting a close that did not happen', async () => {
    stateRef.current.updateError = { message: 'connection terminated' };
    await expect(departFromJob('seg-open', 'crew-1', 'completed', 'office')).rejects.toThrow(
      'departFromJob: connection terminated',
    );
    expect(stateRef.current.segments[0].departed_at).toBeNull();
  });
});
