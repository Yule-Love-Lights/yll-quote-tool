import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Source = 'pwa' | 'telegram' | 'office' | 'system';

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  source: Source;
  close_source: Source | null;
  device_time: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type BreakRow = {
  id: string;
  shift_id: string;
  crew_member_id: string;
  started_at: string;
  ended_at: string | null;
  source: Source;
  end_source: Source | null;
  auto_closed: boolean;
  device_time: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type DbError = { code?: string; message: string };

const OPEN_SHIFT: ShiftRow = {
  id: 'shift-open-1',
  crew_member_id: 'crew-1',
  clock_in_at: '2026-08-10T12:00:00.000Z',
  clock_out_at: null,
  source: 'pwa',
  close_source: null,
  device_time: null,
  created_at: '2026-08-10T12:00:00.000Z',
  updated_at: '2026-08-10T12:00:00.000Z',
};

const CLOSED_SHIFT: ShiftRow = {
  id: 'shift-closed-1',
  crew_member_id: 'crew-2',
  clock_in_at: '2026-08-10T08:00:00.000Z',
  clock_out_at: '2026-08-10T10:00:00.000Z',
  source: 'office',
  close_source: 'office',
  device_time: null,
  created_at: '2026-08-10T08:00:00.000Z',
  updated_at: '2026-08-10T10:00:00.000Z',
};

const OPEN_BREAK: BreakRow = {
  id: 'break-open-1',
  shift_id: 'shift-open-1',
  crew_member_id: 'crew-1',
  started_at: '2026-08-10T13:00:00.000Z',
  ended_at: null,
  source: 'telegram',
  end_source: null,
  auto_closed: false,
  device_time: null,
  created_at: '2026-08-10T13:00:00.000Z',
  updated_at: '2026-08-10T13:00:00.000Z',
};

const ENDED_BREAK: BreakRow = {
  id: 'break-ended-1',
  shift_id: 'shift-closed-1',
  crew_member_id: 'crew-2',
  started_at: '2026-08-10T09:00:00.000Z',
  ended_at: '2026-08-10T09:30:00.000Z',
  source: 'telegram',
  end_source: 'telegram',
  auto_closed: false,
  device_time: null,
  created_at: '2026-08-10T09:00:00.000Z',
  updated_at: '2026-08-10T09:30:00.000Z',
};

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      shifts: [] as ShiftRow[],
      breaks: [] as BreakRow[],
      inserted: [] as Record<string, unknown>[],
      updated: [] as Record<string, unknown>[],
      insertRaceRow: null as BreakRow | null,
      selectError: null as DbError | null,
      updateError: null as DbError | null,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

function makeInsertedBreak(payload: Record<string, unknown>): BreakRow {
  const now = new Date().toISOString();
  return {
    id: `generated-${stateRef.current.breaks.length + 1}`,
    shift_id: String(payload.shift_id),
    crew_member_id: String(payload.crew_member_id),
    started_at: (payload.started_at as string | undefined) ?? now,
    ended_at: null,
    source: payload.source as Source,
    end_source: null,
    auto_closed: false,
    device_time: (payload.device_time as string | null | undefined) ?? null,
    created_at: now,
    updated_at: now,
  };
}

function matches<T extends object>(row: T, filters: Partial<Record<keyof T, unknown>>) {
  return Object.entries(filters).every(([key, value]) => row[key as keyof T] === value);
}

function makeDb() {
  return {
    from(table: string) {
      if (table !== 'shifts' && table !== 'shift_breaks') {
        throw new Error(`shiftBreaks.test.ts: unexpected table ${table}`);
      }
      const isBreaks = table === 'shift_breaks';

      const source = () =>
        (isBreaks ? stateRef.current.breaks : stateRef.current.shifts) as Array<
          Record<string, unknown>
        >;

      let filtered = [...source()];
      const filters: Record<string, unknown> = {};

      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          filtered = filtered.filter((row) => row[col] === val);
          return builder;
        },
        is: (col: string, val: unknown) => {
          if (val === null) {
            filters[col] = null;
            filtered = filtered.filter((row) => row[col] === null);
          }
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          // Real ordering, so a test can actually prove the sort rather than
          // relying on a single-row fixture (S58 wrap review, technical lens).
          const ascending = opts?.ascending !== false;
          filtered = [...filtered].sort((a, b) => {
            const av = String(a[col] ?? '');
            const bv = String(b[col] ?? '');
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({
            data: stateRef.current.selectError ? null : (filtered[0] ?? null),
            error: stateRef.current.selectError,
          }),
        // The real query builder is thenable; awaiting it resolves the list form.
        then: (resolve: (value: { data: unknown; error: DbError | null }) => unknown) =>
          resolve({
            data: stateRef.current.selectError ? null : filtered,
            error: stateRef.current.selectError,
          }),
        insert: (payload: Record<string, unknown>) => {
          stateRef.current.inserted.push(payload);

          if (stateRef.current.insertRaceRow) {
            const winner = stateRef.current.insertRaceRow;
            stateRef.current.insertRaceRow = null;
            stateRef.current.breaks.push(winner);
            return {
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: null,
                    error: {
                      code: '23505',
                      message:
                        'duplicate key value violates unique constraint "shift_breaks_one_open_per_shift"',
                    } as DbError,
                  }),
              }),
            };
          }

          const row = makeInsertedBreak(payload);
          stateRef.current.breaks.push(row);
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: row, error: null }),
            }),
          };
        },
        update: (payload: Record<string, unknown>) => {
          const updateFilters: Record<string, unknown> = {};
          const updateBuilder = {
            eq: (col: string, val: unknown) => {
              updateFilters[col] = val;
              return updateBuilder;
            },
            is: (col: string, val: unknown) => {
              updateFilters[col] = val;
              return updateBuilder;
            },
            select: () => ({
              maybeSingle: () => {
                if (stateRef.current.updateError) {
                  return Promise.resolve({ data: null, error: stateRef.current.updateError });
                }
                const rows = source();
                const idx = rows.findIndex((row) => matches(row, updateFilters));
                if (idx === -1) return Promise.resolve({ data: null, error: null });
                // Record only updates that actually matched a row, so a guarded
                // no-op update does not read as a write in the assertions.
                stateRef.current.updated.push(payload);
                const next = { ...rows[idx], ...payload, updated_at: new Date().toISOString() };
                rows[idx] = next;
                return Promise.resolve({ data: next, error: null });
              },
            }),
          };
          return updateBuilder;
        },
      };

      return builder;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-10T15:30:00.000Z'));
  stateRef.current = {
    shifts: [{ ...OPEN_SHIFT }, { ...CLOSED_SHIFT }],
    breaks: [{ ...OPEN_BREAK }, { ...ENDED_BREAK }],
    inserted: [],
    updated: [],
    insertRaceRow: null,
    selectError: null,
    updateError: null,
  };
  dbRef.current = makeDb();
});

afterEach(() => {
  vi.useRealTimers();
});

import {
  breakSecondsForShift,
  closeOpenBreakForShift,
  endBreak,
  getOpenBreak,
  listBreaks,
  paidSecondsForShift,
  startBreak,
} from './shiftBreaks';

// ---------------------------------------------------------------------------
// The money math. Breaks are UNPAID per OPERATIONS_HUB_CONTRACT.md section 8,
// so paid time is the shift envelope minus break time. These are pure
// functions with no database in the way.
// ---------------------------------------------------------------------------

const shift = (clockInAt: string, clockOutAt: string | null) => ({ clockInAt, clockOutAt });
const brk = (startedAt: string, endedAt: string | null) => ({ startedAt, endedAt });

describe('paidSecondsForShift', () => {
  it('pays the whole envelope when there are no breaks', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), []),
    ).toBe(8 * 3600);
  });

  it('subtracts a single break', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T12:00:00.000Z', '2026-08-10T12:30:00.000Z'),
      ]),
    ).toBe(8 * 3600 - 30 * 60);
  });

  it('subtracts several breaks', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T10:00:00.000Z', '2026-08-10T10:15:00.000Z'),
        brk('2026-08-10T12:00:00.000Z', '2026-08-10T12:30:00.000Z'),
        brk('2026-08-10T14:00:00.000Z', '2026-08-10T14:10:00.000Z'),
      ]),
    ).toBe(8 * 3600 - (15 + 30 + 10) * 60);
  });

  it('clips a break that runs past clock-out so it cannot subtract unworked time', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T15:30:00.000Z', '2026-08-10T18:00:00.000Z'),
      ]),
    ).toBe(8 * 3600 - 30 * 60);
  });

  it('clips a break that starts before clock-in', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T07:00:00.000Z', '2026-08-10T08:30:00.000Z'),
      ]),
    ).toBe(8 * 3600 - 30 * 60);
  });

  it('ignores a break entirely outside the envelope', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T17:00:00.000Z', '2026-08-10T17:30:00.000Z'),
      ]),
    ).toBe(8 * 3600);
  });

  it('merges overlapping breaks instead of subtracting the overlap twice', () => {
    // Two office corrections that overlap. Naive summing would subtract 60
    // minutes and underpay; the union is 45 minutes.
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T12:00:00.000Z', '2026-08-10T12:30:00.000Z'),
        brk('2026-08-10T12:15:00.000Z', '2026-08-10T12:45:00.000Z'),
      ]),
    ).toBe(8 * 3600 - 45 * 60);
  });

  it('merges a break fully contained inside another', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T12:00:00.000Z', '2026-08-10T13:00:00.000Z'),
        brk('2026-08-10T12:15:00.000Z', '2026-08-10T12:30:00.000Z'),
      ]),
    ).toBe(8 * 3600 - 60 * 60);
  });

  it('treats an open shift as running to now', () => {
    // System time is 15:30Z.
    expect(paidSecondsForShift(shift('2026-08-10T12:00:00.000Z', null), [])).toBe(3.5 * 3600);
  });

  it('treats an open break as running to now', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T12:00:00.000Z', null), [
        brk('2026-08-10T15:00:00.000Z', null),
      ]),
    ).toBe(3 * 3600);
  });

  it('never returns a negative number', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T09:00:00.000Z'), [
        brk('2026-08-10T08:00:00.000Z', '2026-08-10T12:00:00.000Z'),
      ]),
    ).toBe(0);
  });

  it('returns 0 for a shift whose clock-out precedes its clock-in', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T16:00:00.000Z', '2026-08-10T08:00:00.000Z'), []),
    ).toBe(0);
  });

  it('returns an integer, and rounds sub-second remainders UP toward the employee', () => {
    const value = paidSecondsForShift(
      shift('2026-08-10T08:00:00.000Z', '2026-08-10T08:00:10.500Z'),
      [],
    );
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(11);
  });

  it('rounds a sub-second break DOWN, which also favors the employee', () => {
    // 60s envelope, a 10.5s break. Break floors to 10, so paid is 60 - 10 = 50:
    // the half second of break is not charged against the crew member.
    const value = paidSecondsForShift(
      shift('2026-08-10T08:00:00.000Z', '2026-08-10T08:01:00.000Z'),
      [brk('2026-08-10T08:00:10.000Z', '2026-08-10T08:00:20.500Z')],
    );
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(50);
  });

  it('ignores an unparseable timestamp rather than poisoning the total', () => {
    expect(
      paidSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('not-a-date', '2026-08-10T12:30:00.000Z'),
      ]),
    ).toBe(8 * 3600);
  });
});

describe('breakSecondsForShift', () => {
  it('reports the merged, clipped break total', () => {
    expect(
      breakSecondsForShift(shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z'), [
        brk('2026-08-10T12:00:00.000Z', '2026-08-10T12:30:00.000Z'),
        brk('2026-08-10T12:15:00.000Z', '2026-08-10T12:45:00.000Z'),
      ]),
    ).toBe(45 * 60);
  });

  it('and the two sum back to the envelope on whole-second inputs', () => {
    const s = shift('2026-08-10T08:00:00.000Z', '2026-08-10T16:00:00.000Z');
    const breaks = [brk('2026-08-10T12:00:00.000Z', '2026-08-10T12:30:00.000Z')];
    expect(paidSecondsForShift(s, breaks) + breakSecondsForShift(s, breaks)).toBe(8 * 3600);
  });

  it('and they still sum back to the envelope on MILLISECOND inputs', () => {
    // The case the earlier implementation got wrong, and the earlier version of
    // this test never covered: rounding each half up independently gave
    // paid 11 + break 1 = 12 against an 11-second envelope. Real timestamps
    // carry milliseconds, so this is the normal case, not an edge case.
    const s = shift('2026-08-10T08:00:00.000Z', '2026-08-10T08:00:10.700Z');
    const breaks = [brk('2026-08-10T08:00:00.000Z', '2026-08-10T08:00:00.400Z')];

    const envelope = 11; // ceil(10_700 / 1000)
    expect(paidSecondsForShift(s, breaks) + breakSecondsForShift(s, breaks)).toBe(envelope);
  });

  it('holds the identity across a spread of awkward millisecond values', () => {
    const cases: Array<[string, string, string, string]> = [
      ['08:00:00.000', '08:00:10.700', '08:00:00.000', '08:00:00.400'],
      ['08:00:00.123', '09:17:43.987', '08:30:00.500', '08:45:12.250'],
      ['08:00:00.999', '16:00:00.001', '12:00:00.001', '12:30:00.999'],
      ['08:00:00.500', '08:00:01.499', '08:00:00.600', '08:00:00.900'],
    ];

    for (const [inAt, outAt, bStart, bEnd] of cases) {
      const s = shift(`2026-08-10T${inAt}Z`, `2026-08-10T${outAt}Z`);
      const breaks = [brk(`2026-08-10T${bStart}Z`, `2026-08-10T${bEnd}Z`)];
      const paid = paidSecondsForShift(s, breaks);
      const unpaid = breakSecondsForShift(s, breaks);

      expect(Number.isInteger(paid)).toBe(true);
      expect(Number.isInteger(unpaid)).toBe(true);
      expect(paid).toBeGreaterThanOrEqual(0);
      // The whole envelope is accounted for: nothing vanishes, nothing is minted.
      const envelope = paidSecondsForShift(s, []);
      expect(paid + unpaid).toBe(envelope);
    }
  });

  it('never lets break time exceed the envelope it is subtracted from', () => {
    const s = shift('2026-08-10T08:00:00.000Z', '2026-08-10T09:00:00.000Z');
    const breaks = [brk('2026-08-10T07:00:00.000Z', '2026-08-10T18:00:00.000Z')];
    expect(breakSecondsForShift(s, breaks)).toBe(3600);
    expect(paidSecondsForShift(s, breaks)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The ledger writes.
// ---------------------------------------------------------------------------

describe('getOpenBreak', () => {
  it('returns null when the shift has no open break', async () => {
    await expect(getOpenBreak('shift-closed-1')).resolves.toBeNull();
  });

  it('maps the open row to camelCase', async () => {
    await expect(getOpenBreak(' shift-open-1 ')).resolves.toEqual({
      id: 'break-open-1',
      shiftId: 'shift-open-1',
      crewMemberId: 'crew-1',
      startedAt: '2026-08-10T13:00:00.000Z',
      endedAt: null,
      source: 'telegram',
      endSource: null,
      autoClosed: false,
      deviceTime: null,
      createdAt: '2026-08-10T13:00:00.000Z',
      updatedAt: '2026-08-10T13:00:00.000Z',
    });
  });
});

describe('listBreaks', () => {
  it('returns every break on the shift', async () => {
    const rows = await listBreaks('shift-open-1');
    expect(rows.map((row) => row.id)).toEqual(['break-open-1']);
  });

  it('returns an empty array for a shift with none', async () => {
    await expect(listBreaks('shift-nobreaks')).resolves.toEqual([]);
  });

  it('returns the breaks oldest-first, proven with more than one row', async () => {
    stateRef.current.breaks = [
      { ...OPEN_BREAK, id: 'b-late', started_at: '2026-08-10T14:00:00.000Z', ended_at: null },
      {
        ...ENDED_BREAK,
        id: 'b-early',
        shift_id: 'shift-open-1',
        crew_member_id: 'crew-1',
        started_at: '2026-08-10T09:00:00.000Z',
      },
      {
        ...ENDED_BREAK,
        id: 'b-middle',
        shift_id: 'shift-open-1',
        crew_member_id: 'crew-1',
        started_at: '2026-08-10T11:30:00.000Z',
      },
    ];

    const rows = await listBreaks('shift-open-1');
    expect(rows.map((row) => row.id)).toEqual(['b-early', 'b-middle', 'b-late']);
  });
});

// These cover the error branches that the mocks previously never reached, so a
// broken `error.message` interpolation would have shipped green (S58 wrap
// review, technical lens).
describe('database error handling', () => {
  const dbError = { code: '08006', message: 'connection terminated' };

  it('getOpenBreak swallows a read error and reports no open break', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      stateRef.current.selectError = dbError;
      await expect(getOpenBreak('shift-open-1')).resolves.toBeNull();
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0]?.[1])).toContain('connection terminated');
    } finally {
      spy.mockRestore();
    }
  });

  it('listBreaks swallows a read error and reports no breaks', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      stateRef.current.selectError = dbError;
      await expect(listBreaks('shift-open-1')).resolves.toEqual([]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('startBreak surfaces a shift-lookup error rather than opening a break blind', async () => {
    stateRef.current.selectError = dbError;
    await expect(startBreak('shift-open-1', 'crew-1', 'pwa')).rejects.toThrow(
      'startBreak: connection terminated',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('endBreak surfaces an update error rather than reporting a close that did not happen', async () => {
    stateRef.current.updateError = dbError;
    await expect(endBreak('break-open-1', 'crew-1', 'office')).rejects.toThrow(
      'endBreak: connection terminated',
    );
    expect(stateRef.current.breaks.find((row) => row.id === 'break-open-1')?.ended_at).toBeNull();
  });

  it('closeOpenBreakForShift surfaces an update error to its caller', async () => {
    stateRef.current.updateError = dbError;
    await expect(
      closeOpenBreakForShift('shift-open-1', '2026-08-10T15:30:00.000Z', 'office'),
    ).rejects.toThrow('closeOpenBreakForShift: connection terminated');
  });
});

describe('startBreak', () => {
  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(startBreak('shift-open-1', 'crew-1', 'telegram')).rejects.toThrow(
      'Supabase service role not configured',
    );
  });

  it('rejects a break on a shift that does not exist', async () => {
    await expect(startBreak('shift-missing', 'crew-1', 'telegram')).rejects.toThrow(
      'startBreak: no shift found for id shift-missing',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('rejects a break with no open shift, because break time is only meaningful inside one', async () => {
    await expect(startBreak('shift-closed-1', 'crew-2', 'telegram')).rejects.toThrow(
      'startBreak: shift shift-closed-1 is already closed',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it("rejects a break on someone else's shift", async () => {
    await expect(startBreak('shift-open-1', 'crew-2', 'telegram')).rejects.toThrow(
      'startBreak: shift shift-open-1 belongs to crew-1, not crew-2',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('creates a break when the shift is open and has none running', async () => {
    stateRef.current.breaks = [{ ...ENDED_BREAK }];
    await expect(startBreak('shift-open-1', 'crew-1', 'pwa')).resolves.toMatchObject({
      shiftId: 'shift-open-1',
      crewMemberId: 'crew-1',
      startedAt: '2026-08-10T15:30:00.000Z',
      endedAt: null,
      source: 'pwa',
      endSource: null,
      autoClosed: false,
    });
    expect(stateRef.current.inserted).toEqual([
      { shift_id: 'shift-open-1', crew_member_id: 'crew-1', source: 'pwa' },
    ]);
  });

  it('returns the running break on a double-tap instead of opening a second one', async () => {
    // A retry on bad signal must not create a second row, and must not silently
    // restart the clock on the break already running.
    await expect(startBreak('shift-open-1', 'crew-1', 'pwa')).resolves.toMatchObject({
      id: 'break-open-1',
      startedAt: '2026-08-10T13:00:00.000Z',
      source: 'telegram',
    });
    expect(stateRef.current.inserted).toEqual([]);
    expect(stateRef.current.breaks.filter((row) => row.ended_at === null)).toHaveLength(1);
  });

  it('recovers the winner when a concurrent double-tap trips the unique index', async () => {
    stateRef.current.breaks = [{ ...ENDED_BREAK }];
    stateRef.current.insertRaceRow = {
      ...OPEN_BREAK,
      id: 'break-race-1',
      started_at: '2026-08-10T15:29:59.000Z',
    };

    await expect(startBreak('shift-open-1', 'crew-1', 'pwa')).resolves.toMatchObject({
      id: 'break-race-1',
      startedAt: '2026-08-10T15:29:59.000Z',
    });
    expect(stateRef.current.breaks.filter((row) => row.ended_at === null)).toHaveLength(1);
  });
});

describe('endBreak', () => {
  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(endBreak('break-open-1', 'crew-1', 'telegram')).rejects.toThrow(
      'Supabase service role not configured',
    );
  });

  it('closes the running break at the current time', async () => {
    await expect(endBreak('break-open-1', 'crew-1', 'office')).resolves.toMatchObject({
      id: 'break-open-1',
      endedAt: '2026-08-10T15:30:00.000Z',
      endSource: 'office',
      autoClosed: false,
    });
    expect(stateRef.current.updated).toEqual([
      { ended_at: '2026-08-10T15:30:00.000Z', end_source: 'office' },
    ]);
  });

  it('rejects when the break id does not exist', async () => {
    await expect(endBreak('break-missing', 'crew-1', 'office')).rejects.toThrow(
      'endBreak: no break found for id break-missing',
    );
  });

  it("rejects when the break belongs to someone else", async () => {
    await expect(endBreak('break-open-1', 'crew-2', 'office')).rejects.toThrow(
      'endBreak: break break-open-1 belongs to crew-1, not crew-2',
    );
  });

  it('rejects ending a break that already ended, rather than moving its end time', async () => {
    await expect(endBreak('break-ended-1', 'crew-2', 'office')).rejects.toThrow(
      'endBreak: break break-ended-1 already ended',
    );
    expect(
      stateRef.current.breaks.find((row) => row.id === 'break-ended-1')?.ended_at,
    ).toBe('2026-08-10T09:30:00.000Z');
  });
});

describe('closeOpenBreakForShift', () => {
  it('closes the running break at the punch time and marks it auto-closed for review', async () => {
    await expect(
      closeOpenBreakForShift('shift-open-1', '2026-08-10T15:30:00.000Z', 'office'),
    ).resolves.toMatchObject({
      id: 'break-open-1',
      endedAt: '2026-08-10T15:30:00.000Z',
      endSource: 'office',
      autoClosed: true,
    });
    expect(stateRef.current.updated).toEqual([
      { ended_at: '2026-08-10T15:30:00.000Z', end_source: 'office', auto_closed: true },
    ]);
  });

  it('returns null when the shift has no running break', async () => {
    await expect(
      closeOpenBreakForShift('shift-closed-1', '2026-08-10T15:30:00.000Z', 'office'),
    ).resolves.toBeNull();
    expect(stateRef.current.updated).toEqual([]);
  });

  it('is a no-op the second time, so a retried clock-out cannot move the end time', async () => {
    await closeOpenBreakForShift('shift-open-1', '2026-08-10T15:30:00.000Z', 'office');
    await expect(
      closeOpenBreakForShift('shift-open-1', '2026-08-10T16:00:00.000Z', 'office'),
    ).resolves.toBeNull();
    expect(stateRef.current.breaks.find((row) => row.id === 'break-open-1')?.ended_at).toBe(
      '2026-08-10T15:30:00.000Z',
    );
  });
});
