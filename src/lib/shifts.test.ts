import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  source: 'pwa' | 'telegram' | 'office' | 'system';
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
  device_time: null,
  created_at: '2026-08-10T08:00:00.000Z',
  updated_at: '2026-08-10T10:00:00.000Z',
};

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      rows: [] as ShiftRow[],
      selectError: null as DbError | null,
      updateError: null as DbError | null,
      inserted: [] as Record<string, unknown>[],
      updated: [] as Record<string, unknown>[],
      insertRaceRow: null as ShiftRow | null,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

function makeInsertedRow(payload: Record<string, unknown>): ShiftRow {
  const now = new Date().toISOString();
  return {
    id: `generated-${stateRef.current.rows.length + 1}`,
    crew_member_id: String(payload.crew_member_id),
    clock_in_at: now,
    clock_out_at: null,
    source: payload.source as ShiftRow['source'],
    device_time: (payload.device_time as string | null | undefined) ?? null,
    created_at: now,
    updated_at: now,
  };
}

function matches(row: ShiftRow, filters: Partial<Record<keyof ShiftRow, unknown>>) {
  return Object.entries(filters).every(([key, value]) => row[key as keyof ShiftRow] === value);
}

function makeDb() {
  return {
    from(table: string) {
      if (table !== 'shifts') {
        throw new Error(`shifts.test.ts: unexpected table ${table}`);
      }

      let filtered = [...stateRef.current.rows];
      const filters: Partial<Record<keyof ShiftRow, unknown>> = {};

      const builder = {
        select: () => builder,
        eq: (col: keyof ShiftRow, val: unknown) => {
          filters[col] = val;
          filtered = filtered.filter((row) => row[col] === val);
          return builder;
        },
        is: (col: keyof ShiftRow, val: unknown) => {
          if (val === null) {
            filters[col] = null;
            filtered = filtered.filter((row) => row[col] === null);
          }
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: stateRef.current.selectError }),
        insert: (payload: Record<string, unknown>) => {
          stateRef.current.inserted.push(payload);

          if (stateRef.current.insertRaceRow) {
            const raceWinner = stateRef.current.insertRaceRow;
            stateRef.current.insertRaceRow = null;
            stateRef.current.rows.push(raceWinner);
            return {
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: null,
                    error: {
                      code: '23505',
                      message:
                        'duplicate key value violates unique constraint "shifts_one_open_per_person"',
                    },
                  }),
              }),
            };
          }

          const row = makeInsertedRow(payload);
          stateRef.current.rows.push(row);
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: row, error: null }),
            }),
          };
        },
        update: (payload: Record<string, unknown>) => {
          stateRef.current.updated.push(payload);
          let updateFilters: Partial<Record<keyof ShiftRow, unknown>> = {};
          const updateBuilder = {
            eq: (col: keyof ShiftRow, val: unknown) => {
              updateFilters = { ...updateFilters, [col]: val };
              return updateBuilder;
            },
            is: (col: keyof ShiftRow, val: unknown) => {
              updateFilters = { ...updateFilters, [col]: val };
              return updateBuilder;
            },
            select: () => ({
              maybeSingle: () => {
                if (stateRef.current.updateError) {
                  return Promise.resolve({ data: null, error: stateRef.current.updateError });
                }

                const idx = stateRef.current.rows.findIndex((row) => matches(row, updateFilters));
                if (idx === -1) {
                  return Promise.resolve({ data: null, error: null });
                }

                const existing = stateRef.current.rows[idx];
                const next: ShiftRow = {
                  ...existing,
                  ...payload,
                  updated_at: new Date().toISOString(),
                } as ShiftRow;
                stateRef.current.rows[idx] = next;
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
    rows: [OPEN_SHIFT, CLOSED_SHIFT],
    selectError: null,
    updateError: null,
    inserted: [],
    updated: [],
    insertRaceRow: null,
  };
  dbRef.current = makeDb();
});

afterEach(() => {
  vi.useRealTimers();
});

import { clockIn, clockOut, getOpenShift } from './shifts';

describe('getOpenShift', () => {
  it('returns null when there is no open shift for the crew member', async () => {
    await expect(getOpenShift('crew-missing')).resolves.toBeNull();
  });

  it('maps the open row to camelCase', async () => {
    await expect(getOpenShift(' crew-1 ')).resolves.toEqual({
      id: 'shift-open-1',
      crewMemberId: 'crew-1',
      clockInAt: '2026-08-10T12:00:00.000Z',
      clockOutAt: null,
      source: 'pwa',
      deviceTime: null,
      createdAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
    });
  });
});

describe('clockIn', () => {
  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(clockIn('crew-1', 'pwa')).rejects.toThrow('Supabase service role not configured');
  });

  it('creates and returns a new open shift when none exists', async () => {
    await expect(clockIn('crew-3', 'telegram')).resolves.toEqual({
      id: 'generated-3',
      crewMemberId: 'crew-3',
      clockInAt: '2026-08-10T15:30:00.000Z',
      clockOutAt: null,
      source: 'telegram',
      deviceTime: null,
      createdAt: '2026-08-10T15:30:00.000Z',
      updatedAt: '2026-08-10T15:30:00.000Z',
    });

    expect(stateRef.current.inserted).toEqual([{ crew_member_id: 'crew-3', source: 'telegram' }]);
    expect(stateRef.current.rows).toHaveLength(3);
  });

  it('returns the existing open shift on a repeat clock-in without creating a second row', async () => {
    await expect(clockIn('crew-1', 'pwa')).resolves.toEqual({
      id: 'shift-open-1',
      crewMemberId: 'crew-1',
      clockInAt: '2026-08-10T12:00:00.000Z',
      clockOutAt: null,
      source: 'pwa',
      deviceTime: null,
      createdAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
    });

    expect(stateRef.current.inserted).toEqual([]);
    expect(stateRef.current.rows).toHaveLength(2);
  });

  it('recovers the winner of a concurrent double clock-in when the unique index fires', async () => {
    stateRef.current.insertRaceRow = {
      id: 'shift-race-1',
      crew_member_id: 'crew-9',
      clock_in_at: '2026-08-10T15:29:59.000Z',
      clock_out_at: null,
      source: 'pwa',
      device_time: null,
      created_at: '2026-08-10T15:29:59.000Z',
      updated_at: '2026-08-10T15:29:59.000Z',
    };

    await expect(clockIn('crew-9', 'telegram')).resolves.toEqual({
      id: 'shift-race-1',
      crewMemberId: 'crew-9',
      clockInAt: '2026-08-10T15:29:59.000Z',
      clockOutAt: null,
      source: 'pwa',
      deviceTime: null,
      createdAt: '2026-08-10T15:29:59.000Z',
      updatedAt: '2026-08-10T15:29:59.000Z',
    });

    expect(stateRef.current.inserted).toEqual([{ crew_member_id: 'crew-9', source: 'telegram' }]);
    expect(stateRef.current.rows.filter((row) => row.crew_member_id === 'crew-9')).toHaveLength(1);
  });
});

describe('clockOut', () => {
  it('closes an open shift at the current time', async () => {
    await expect(clockOut('shift-open-1', 'crew-1', 'office')).resolves.toEqual({
      id: 'shift-open-1',
      crewMemberId: 'crew-1',
      clockInAt: '2026-08-10T12:00:00.000Z',
      clockOutAt: '2026-08-10T15:30:00.000Z',
      source: 'pwa',
      deviceTime: null,
      createdAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T15:30:00.000Z',
    });

    expect(stateRef.current.updated).toEqual([{ clock_out_at: '2026-08-10T15:30:00.000Z' }]);
  });

  it("rejects when the shift belongs to someone else", async () => {
    await expect(clockOut('shift-open-1', 'crew-2', 'office')).rejects.toThrow(
      'clockOut: shift shift-open-1 belongs to crew-1, not crew-2',
    );
  });

  it('rejects when the shift is already closed', async () => {
    await expect(clockOut('shift-closed-1', 'crew-2', 'office')).rejects.toThrow(
      'clockOut: shift shift-closed-1 is already closed',
    );
  });

  it('rejects when the shift id does not exist', async () => {
    await expect(clockOut('missing-shift', 'crew-2', 'office')).rejects.toThrow(
      'clockOut: no shift found for id missing-shift',
    );
  });
});
