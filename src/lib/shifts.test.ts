import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  source: 'pwa' | 'telegram' | 'office' | 'system';
  close_source: 'pwa' | 'telegram' | 'office' | 'system' | null;
  device_time: string | null;
  manual_by: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type DbError = { code?: string; message: string };

type BreakRow = {
  id: string;
  shift_id: string;
  crew_member_id: string;
  started_at: string;
  ended_at: string | null;
  source: ShiftRow['source'];
  end_source: ShiftRow['source'] | null;
  auto_closed: boolean;
  device_time: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const OPEN_BREAK: BreakRow = {
  id: 'break-open-1',
  shift_id: 'shift-open-1',
  crew_member_id: 'crew-1',
  started_at: '2026-08-10T14:00:00.000Z',
  ended_at: null,
  source: 'telegram',
  end_source: null,
  auto_closed: false,
  device_time: null,
  created_at: '2026-08-10T14:00:00.000Z',
  updated_at: '2026-08-10T14:00:00.000Z',
};

const OPEN_SHIFT: ShiftRow = {
  id: 'shift-open-1',
  crew_member_id: 'crew-1',
  clock_in_at: '2026-08-10T12:00:00.000Z',
  clock_out_at: null,
  source: 'pwa',
  close_source: null,
  device_time: null,
  manual_by: null,
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
  manual_by: null,
  created_at: '2026-08-10T08:00:00.000Z',
  updated_at: '2026-08-10T10:00:00.000Z',
};

const { dbRef, stateRef, sendTelegramMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  sendTelegramMock: vi.fn(async (_chatId: number | string, _text: string) => undefined),
  stateRef: {
    current: {
      rows: [] as ShiftRow[],
      selectError: null as DbError | null,
      updateError: null as DbError | null,
      inserted: [] as Record<string, unknown>[],
      updated: [] as Record<string, unknown>[],
      insertRaceRow: null as ShiftRow | null,
      insertError: null as DbError | null,
      afterSelect: null as (() => void) | null,
      breaks: [] as BreakRow[],
      breakUpdates: [] as Record<string, unknown>[],
      segments: [] as Record<string, unknown>[],
      segmentUpdates: [] as Record<string, unknown>[],
      crewMembers: [] as { id: string; active: boolean; is_office: boolean; telegram_user_id: string | null }[],
      activityInserts: [] as Record<string, unknown>[],
      deleted: [] as ShiftRow[],
      deleteError: null as DbError | null,
      activityError: null as DbError | null,
      childReadError: null as DbError | null,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

vi.mock('@/lib/integrations/telegram', () => ({
  sendTelegramMessage: sendTelegramMock,
}));

function makeInsertedRow(payload: Record<string, unknown>): ShiftRow {
  const now = new Date().toISOString();
  return {
    id: `generated-${stateRef.current.rows.length + 1}`,
    crew_member_id: String(payload.crew_member_id),
    clock_in_at: (payload.clock_in_at as string | undefined) ?? now,
    clock_out_at: (payload.clock_out_at as string | null | undefined) ?? null,
    source: payload.source as ShiftRow['source'],
    close_source: (payload.close_source as ShiftRow['close_source'] | undefined) ?? null,
    device_time: (payload.device_time as string | null | undefined) ?? null,
    manual_by: (payload.manual_by as string | null | undefined) ?? null,
    created_at: now,
    updated_at: now,
  };
}

function matches(row: ShiftRow, filters: Partial<Record<keyof ShiftRow, unknown>>) {
  return Object.entries(filters).every(([key, value]) => row[key as keyof ShiftRow] === value);
}

/**
 * The child-table half of the mock, shared by `shift_breaks` and `job_segments`.
 * `clockOut` auto-closes a running break AND a running job segment, so both are
 * reachable from these tests. Only the guarded update those closers issue is
 * modelled.
 *
 * This was previously breaks-only, and the `unexpected table` throw for
 * job_segments was silently swallowed by clockOut's own try/catch — so the
 * segment auto-close read as covered while never actually running.
 */
function makeChildBuilder(
  rows: () => Array<Record<string, unknown>>,
  log: () => Array<Record<string, unknown>>,
) {
  const childBuilder = {
    // Read path: single-row getters use maybeSingle; the containment guard
    // awaits the builder directly for a LIST.
    select: () => {
      let filtered = [...rows()];
      const readBuilder = {
        eq: (col: string, val: unknown) => {
          filtered = filtered.filter((row) => row[col] === val);
          return readBuilder;
        },
        is: (col: string, val: unknown) => {
          if (val === null) filtered = filtered.filter((row) => row[col] === null);
          return readBuilder;
        },
        maybeSingle: () =>
          Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null }),
        then: (
          res: (v: { data: Array<Record<string, unknown>> | null; error: DbError | null }) => unknown,
          rej?: (e: unknown) => unknown,
        ) =>
          Promise.resolve(
            stateRef.current.childReadError
              ? { data: null, error: stateRef.current.childReadError }
              : { data: filtered.map((r) => ({ ...r })), error: null },
          ).then(res, rej),
      };
      return readBuilder;
    },
    update: (payload: Record<string, unknown>) => {
      const filters: Record<string, unknown> = {};
      const updateBuilder = {
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return updateBuilder;
        },
        is: (col: string, val: unknown) => {
          filters[col] = val;
          return updateBuilder;
        },
        select: () => ({
          maybeSingle: () => {
            const list = rows();
            const idx = list.findIndex((row) =>
              Object.entries(filters).every(([key, value]) => row[key] === value),
            );
            if (idx === -1) return Promise.resolve({ data: null, error: null });
            log().push(payload);
            const next = { ...list[idx], ...payload, updated_at: new Date().toISOString() };
            list[idx] = next;
            return Promise.resolve({ data: next, error: null });
          },
        }),
      };
      return updateBuilder;
    },
  };
  return childBuilder;
}

function makeDb() {
  return {
    from(table: string) {
      if (table === 'shift_breaks') {
        return makeChildBuilder(
          () => stateRef.current.breaks as unknown as Array<Record<string, unknown>>,
          () => stateRef.current.breakUpdates,
        ) as never;
      }
      if (table === 'job_segments') {
        return makeChildBuilder(
          () => stateRef.current.segments,
          () => stateRef.current.segmentUpdates,
        ) as never;
      }
      if (table === 'crew_members') {
        let list = [...stateRef.current.crewMembers];
        const crewBuilder = {
          select: () => crewBuilder,
          eq: (col: string, val: unknown) => {
            list = list.filter((row) => (row as unknown as Record<string, unknown>)[col] === val);
            return crewBuilder;
          },
          maybeSingle: () => Promise.resolve({ data: list[0] ? { ...list[0] } : null, error: null }),
        };
        return crewBuilder as never;
      }
      if (table === 'dashboard_activity') {
        return {
          insert: (payload: Record<string, unknown>) => {
            stateRef.current.activityInserts.push(payload);
            // Supabase returns { error } rather than throwing, so a test that
            // only models a thrown insert proves nothing about a real DB
            // failure (the void audit's whole guard rides on this).
            return Promise.resolve({ error: stateRef.current.activityError });
          },
        } as never;
      }
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
        lt: (col: keyof ShiftRow, val: unknown) => {
          filtered = filtered.filter((row) => {
            const v = row[col];
            return typeof v === 'string' && typeof val === 'string' && v < val;
          });
          return builder;
        },
        // The admin overlap check awaits the builder directly for a LIST.
        then: (res: (v: { data: ShiftRow[]; error: DbError | null }) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: filtered, error: stateRef.current.selectError }).then(res, rej),
        maybeSingle: () => {
          // A COPY, like a real DB read — otherwise the race-injection hook
          // below would mutate the very object the caller just "read" and no
          // CAS could ever be seen to fire.
          const result = {
            data: filtered[0] ? { ...filtered[0] } : null,
            error: stateRef.current.selectError,
          };
          // Race-injection hook: lets a test mutate rows AFTER a read resolves
          // but BEFORE the caller's next write, to prove a CAS actually guards.
          const hook = stateRef.current.afterSelect;
          if (hook) {
            stateRef.current.afterSelect = null;
            hook();
          }
          return Promise.resolve(result);
        },
        insert: (payload: Record<string, unknown>) => {
          stateRef.current.inserted.push(payload);

          if (stateRef.current.insertError) {
            const err = stateRef.current.insertError;
            stateRef.current.insertError = null;
            return {
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: err }),
              }),
            };
          }

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
        // Void path: a guarded DELETE with a CAS on updated_at, mirroring the
        // update builder above so a race can be injected the same way.
        delete: () => {
          let deleteFilters: Partial<Record<keyof ShiftRow, unknown>> = {};
          const deleteBuilder = {
            eq: (col: keyof ShiftRow, val: unknown) => {
              deleteFilters = { ...deleteFilters, [col]: val };
              return deleteBuilder;
            },
            select: () => ({
              maybeSingle: () => {
                if (stateRef.current.deleteError) {
                  return Promise.resolve({ data: null, error: stateRef.current.deleteError });
                }
                const idx = stateRef.current.rows.findIndex((row) => matches(row, deleteFilters));
                if (idx === -1) return Promise.resolve({ data: null, error: null });
                const [removed] = stateRef.current.rows.splice(idx, 1);
                stateRef.current.deleted.push(removed);
                return Promise.resolve({ data: removed, error: null });
              },
            }),
          };
          return deleteBuilder;
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
    insertError: null,
    afterSelect: null,
    breaks: [],
    breakUpdates: [],
    segments: [],
    segmentUpdates: [],
    crewMembers: [
      { id: 'crew-1', active: true, is_office: false, telegram_user_id: null },
      { id: 'crew-2', active: true, is_office: false, telegram_user_id: null },
      { id: 'crew-3', active: true, is_office: false, telegram_user_id: null },
    ],
    activityInserts: [],
    deleted: [],
    deleteError: null,
    activityError: null,
    childReadError: null,
  };
  dbRef.current = makeDb();
});

afterEach(() => {
  vi.useRealTimers();
});

import {
  adminCreateShift,
  adminUpdateShiftTimes,
  adminVoidShift,
  clockIn,
  clockOut,
  getOpenShift,
  ManualShiftRefusedError,
} from './shifts';

// ─── Manual admin entries (2026-08-29, Naldo's ruling) ──────────────────────
// An admin reconstructs a forgotten shift by TYPING times; the GPS timeline is
// reference only. Every refusal is typed so the route can answer honestly.

async function expectRefused(p: Promise<unknown>, code: string) {
  try {
    await p;
    throw new Error(`expected ManualShiftRefusedError(${code}) but nothing was thrown`);
  } catch (e) {
    expect(e).toBeInstanceOf(ManualShiftRefusedError);
    expect((e as ManualShiftRefusedError).code).toBe(code);
  }
}

describe('adminCreateShift', () => {
  const actor = 'Naldo';

  it('creates a closed manual shift stamped with the actor', async () => {
    const got = await adminCreateShift({
      crewMemberId: 'crew-2',
      clockInAt: '2026-08-10T11:00:00.000Z',
      clockOutAt: '2026-08-10T13:00:00.000Z',
      actor,
    });
    expect(got.manualBy).toBe('Naldo');
    expect(got.clockInAt).toBe('2026-08-10T11:00:00.000Z');
    expect(got.clockOutAt).toBe('2026-08-10T13:00:00.000Z');
    expect(stateRef.current.inserted).toEqual([
      {
        crew_member_id: 'crew-2',
        clock_in_at: '2026-08-10T11:00:00.000Z',
        clock_out_at: '2026-08-10T13:00:00.000Z',
        source: 'office',
        close_source: 'office',
        manual_by: 'Naldo',
      },
    ]);
  });

  it('refuses clock-out at or before clock-in (invalid-times), inserting nothing', async () => {
    await expectRefused(
      adminCreateShift({
        crewMemberId: 'crew-2',
        clockInAt: '2026-08-10T13:00:00.000Z',
        clockOutAt: '2026-08-10T13:00:00.000Z',
        actor,
      }),
      'invalid-times',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('refuses an overlap with an existing closed shift', async () => {
    await expectRefused(
      adminCreateShift({
        crewMemberId: 'crew-2',
        clockInAt: '2026-08-10T09:00:00.000Z',
        clockOutAt: '2026-08-10T11:00:00.000Z',
        actor,
      }),
      'overlap',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('refuses an overlap with an OPEN shift (still running counts as occupying all later time)', async () => {
    await expectRefused(
      adminCreateShift({
        crewMemberId: 'crew-1',
        clockInAt: '2026-08-10T13:00:00.000Z',
        clockOutAt: '2026-08-10T14:00:00.000Z',
        actor,
      }),
      'overlap',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('allows a back-to-back shift that touches but does not overlap', async () => {
    const got = await adminCreateShift({
      crewMemberId: 'crew-2',
      clockInAt: '2026-08-10T10:00:00.000Z',
      clockOutAt: '2026-08-10T11:00:00.000Z',
      actor,
    });
    expect(got.clockInAt).toBe('2026-08-10T10:00:00.000Z');
  });
});

describe('adminUpdateShiftTimes', () => {
  const actor = 'Jason';

  it('updates the times, stamps the actor, and guards with a CAS on updated_at', async () => {
    const got = await adminUpdateShiftTimes({
      shiftId: 'shift-closed-1',
      clockInAt: '2026-08-10T08:30:00.000Z',
      clockOutAt: '2026-08-10T10:30:00.000Z',
      actor,
    });
    expect(got.manualBy).toBe('Jason');
    expect(got.clockInAt).toBe('2026-08-10T08:30:00.000Z');
    expect(stateRef.current.updated).toEqual([
      {
        clock_in_at: '2026-08-10T08:30:00.000Z',
        clock_out_at: '2026-08-10T10:30:00.000Z',
        manual_by: 'Jason',
      },
    ]);
  });

  it('closing an OPEN shift records the office as the closer', async () => {
    const got = await adminUpdateShiftTimes({
      shiftId: 'shift-open-1',
      clockInAt: '2026-08-10T12:00:00.000Z',
      clockOutAt: '2026-08-10T15:00:00.000Z',
      actor,
    });
    expect(got.clockOutAt).toBe('2026-08-10T15:00:00.000Z');
    expect(stateRef.current.updated).toEqual([
      {
        clock_in_at: '2026-08-10T12:00:00.000Z',
        clock_out_at: '2026-08-10T15:00:00.000Z',
        close_source: 'office',
        manual_by: 'Jason',
      },
    ]);
  });

  it("refuses an unknown shift id (not-found)", async () => {
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-nope',
        clockInAt: '2026-08-10T08:00:00.000Z',
        clockOutAt: '2026-08-10T09:00:00.000Z',
        actor,
      }),
      'not-found',
    );
  });

  it('refuses clock-out at or before clock-in (invalid-times)', async () => {
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-closed-1',
        clockInAt: '2026-08-10T10:00:00.000Z',
        clockOutAt: '2026-08-10T09:00:00.000Z',
        actor,
      }),
      'invalid-times',
    );
  });

  it("refuses times that would overlap the member's OTHER shift, while excluding itself", async () => {
    stateRef.current.rows.push({
      ...CLOSED_SHIFT,
      id: 'shift-closed-2',
      clock_in_at: '2026-08-10T06:00:00.000Z',
      clock_out_at: '2026-08-10T07:30:00.000Z',
    });
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-closed-1',
        clockInAt: '2026-08-10T07:00:00.000Z',
        clockOutAt: '2026-08-10T09:00:00.000Z',
        actor,
      }),
      'overlap',
    );
  });

  it('refuses a FUTURE-dated entry (an admin typo would silently block that person from ever clocking in)', async () => {
    // Fake clock is 2026-08-10T15:30Z; this entry is tomorrow.
    await expectRefused(
      adminCreateShift({
        crewMemberId: 'crew-2',
        clockInAt: '2026-08-11T07:00:00.000Z',
        clockOutAt: '2026-08-11T15:00:00.000Z',
        actor: 'Naldo',
      }),
      'invalid-times',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('refuses a future clock-in on a keep-open edit too', async () => {
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-open-1',
        clockInAt: '2026-08-11T07:00:00.000Z',
        clockOutAt: null,
        actor: 'Jason',
      }),
      'invalid-times',
    );
    expect(stateRef.current.updated).toEqual([]);
  });

  it("maps the DB exclusion constraint (23P01) to the same 'overlap' refusal", async () => {
    stateRef.current.insertError = {
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint "shifts_no_overlap"',
    };
    await expectRefused(
      adminCreateShift({
        crewMemberId: 'crew-2',
        clockInAt: '2026-08-10T11:00:00.000Z',
        clockOutAt: '2026-08-10T13:00:00.000Z',
        actor: 'Naldo',
      }),
      'overlap',
    );
  });

  it("refuses to create for an office staffer (not-field-crew) — gate at the WRITE, not the dropdown", async () => {
    stateRef.current.crewMembers.push({ id: 'crew-office', active: true, is_office: true, telegram_user_id: null });
    await expectRefused(
      adminCreateShift({
        crewMemberId: 'crew-office',
        clockInAt: '2026-08-10T11:00:00.000Z',
        clockOutAt: '2026-08-10T13:00:00.000Z',
        actor: 'Naldo',
      }),
      'not-field-crew',
    );
    expect(stateRef.current.inserted).toEqual([]);
  });

  it('writes an audit row and notifies a linked crew member after a create', async () => {
    stateRef.current.crewMembers = [
      { id: 'crew-2', active: true, is_office: false, telegram_user_id: '999' },
    ];
    await adminCreateShift({
      crewMemberId: 'crew-2',
      clockInAt: '2026-08-10T11:00:00.000Z',
      clockOutAt: '2026-08-10T13:00:00.000Z',
      actor: 'Naldo',
    });
    expect(stateRef.current.activityInserts).toHaveLength(1);
    expect(stateRef.current.activityInserts[0]).toMatchObject({
      actor: 'Naldo',
      action: 'shift-manual-create',
    });
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMock.mock.calls[0][0]).toBe('999');
  });

  it('keeps an OPEN shift open when clockOutAt is null (edits the clock-in only)', async () => {
    const got = await adminUpdateShiftTimes({
      shiftId: 'shift-open-1',
      clockInAt: '2026-08-10T11:30:00.000Z',
      clockOutAt: null,
      actor: 'Jason',
    });
    expect(got.clockOutAt).toBeNull();
    expect(stateRef.current.updated).toEqual([
      {
        clock_in_at: '2026-08-10T11:30:00.000Z',
        clock_out_at: null,
        manual_by: 'Jason',
      },
    ]);
  });

  it('refuses to REOPEN a closed shift by clearing its clock-out', async () => {
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-closed-1',
        clockInAt: '2026-08-10T08:00:00.000Z',
        clockOutAt: null,
        actor: 'Jason',
      }),
      'invalid-times',
    );
  });

  it('refuses a typed clock-IN later than a running break start (the same clip from the other end)', async () => {
    stateRef.current.breaks = [{ ...OPEN_BREAK }]; // started 14:00 on shift-open-1
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-open-1',
        clockInAt: '2026-08-10T14:30:00.000Z',
        clockOutAt: null,
        actor: 'Jason',
      }),
      'invalid-times',
    );
    expect(stateRef.current.updated).toEqual([]);
  });

  it('refuses moving a CLOSED shift clock-in past its historical break', async () => {
    stateRef.current.breaks = [
      {
        ...OPEN_BREAK,
        id: 'break-done-1',
        shift_id: 'shift-closed-1',
        started_at: '2026-08-10T08:30:00.000Z',
        ended_at: '2026-08-10T09:00:00.000Z',
      },
    ];
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-closed-1',
        clockInAt: '2026-08-10T08:45:00.000Z',
        clockOutAt: '2026-08-10T10:00:00.000Z',
        actor: 'Jason',
      }),
      'invalid-times',
    );
    expect(stateRef.current.updated).toEqual([]);
  });

  it('refuses a typed clock-out earlier than a still-running break (silent-overpay guard)', async () => {
    stateRef.current.breaks = [{ ...OPEN_BREAK }]; // started 14:00 on shift-open-1
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-open-1',
        clockInAt: '2026-08-10T12:00:00.000Z',
        clockOutAt: '2026-08-10T13:00:00.000Z',
        actor: 'Jason',
      }),
      'invalid-times',
    );
    expect(stateRef.current.updated).toEqual([]);
  });

  it('records before and after values in the audit row on an edit', async () => {
    await adminUpdateShiftTimes({
      shiftId: 'shift-closed-1',
      clockInAt: '2026-08-10T08:30:00.000Z',
      clockOutAt: '2026-08-10T10:30:00.000Z',
      actor: 'Jason',
    });
    expect(stateRef.current.activityInserts).toHaveLength(1);
    const detail = stateRef.current.activityInserts[0].detail as {
      before: { clock_in_at: string };
      after: { clock_in_at: string };
    };
    expect(detail.before.clock_in_at).toBe('2026-08-10T08:00:00.000Z');
    expect(detail.after.clock_in_at).toBe('2026-08-10T08:30:00.000Z');
  });

  it('closing an OPEN shift also closes its running break, like clockOut does', async () => {
    stateRef.current.breaks = [{ ...OPEN_BREAK }];
    await adminUpdateShiftTimes({
      shiftId: 'shift-open-1',
      clockInAt: '2026-08-10T12:00:00.000Z',
      clockOutAt: '2026-08-10T15:00:00.000Z',
      actor,
    });
    expect(stateRef.current.breakUpdates).toHaveLength(1);
    expect(stateRef.current.breakUpdates[0]).toMatchObject({ ended_at: '2026-08-10T15:00:00.000Z' });
  });

  it('refuses when the row changed between read and write (edit-race), writing nothing', async () => {
    stateRef.current.afterSelect = () => {
      const row = stateRef.current.rows.find((r) => r.id === 'shift-closed-1');
      if (row) row.updated_at = '2026-08-10T10:00:01.000Z';
    };
    await expectRefused(
      adminUpdateShiftTimes({
        shiftId: 'shift-closed-1',
        clockInAt: '2026-08-10T08:30:00.000Z',
        clockOutAt: '2026-08-10T10:30:00.000Z',
        actor,
      }),
      'edit-race',
    );
    const row = stateRef.current.rows.find((r) => r.id === 'shift-closed-1');
    expect(row?.clock_in_at).toBe('2026-08-10T08:00:00.000Z');
  });
});

// A manual entry that should never have existed cannot be corrected by
// shrinking it: a one-minute shift is still payroll. Voiding DELETES the row,
// which is only safe because the guards below keep it to rows the office
// typed itself, with no break or job time hanging off them (row 458).
describe('adminVoidShift', () => {
  const MANUAL_SHIFT: ShiftRow = {
    id: 'shift-manual-1',
    crew_member_id: 'crew-2',
    clock_in_at: '2026-08-09T12:00:00.000Z',
    clock_out_at: '2026-08-09T20:00:00.000Z',
    source: 'office',
    close_source: 'office',
    device_time: null,
    manual_by: 'Naldo (naldo@example.com)',
    created_at: '2026-08-09T21:00:00.000Z',
    updated_at: '2026-08-09T21:00:00.000Z',
  };

  it('deletes a manual office entry and records the whole row it destroyed', async () => {
    stateRef.current.rows = [MANUAL_SHIFT];

    await adminVoidShift({ shiftId: 'shift-manual-1', actor: 'Kelly (kelly@example.com)' });

    expect(stateRef.current.rows).toHaveLength(0);
    expect(stateRef.current.deleted.map((r) => r.id)).toEqual(['shift-manual-1']);
    // The audit row is the ONLY copy of a deleted shift, so it carries the
    // whole row, not a summary of it.
    expect(stateRef.current.activityInserts).toHaveLength(1);
    const entry = stateRef.current.activityInserts[0] as {
      actor: string;
      action: string;
      detail: { shiftId: string; crewMemberId: string; before: Record<string, unknown> };
    };
    expect(entry.actor).toBe('Kelly (kelly@example.com)');
    expect(entry.action).toBe('shift-manual-void');
    expect(entry.detail.shiftId).toBe('shift-manual-1');
    expect(entry.detail.before).toMatchObject({
      clock_in_at: '2026-08-09T12:00:00.000Z',
      clock_out_at: '2026-08-09T20:00:00.000Z',
      source: 'office',
      manual_by: 'Naldo (naldo@example.com)',
    });
  });

  it('refuses a shift the crew member clocked themselves', async () => {
    // OPEN_SHIFT is source 'pwa': the crew member's own record. Deleting it
    // would erase time they logged, which is not what this action is for.
    await expectRefused(
      adminVoidShift({ shiftId: 'shift-open-1', actor: 'Kelly' }),
      'not-manual',
    );
    expect(stateRef.current.rows.some((r) => r.id === 'shift-open-1')).toBe(true);
  });

  it('refuses an office-source row that carries no manual stamp', async () => {
    // CLOSED_SHIFT is source 'office' with manual_by null: closed from the
    // office, not typed as a manual entry. Both halves have to hold.
    await expectRefused(
      adminVoidShift({ shiftId: 'shift-closed-1', actor: 'Kelly' }),
      'not-manual',
    );
    expect(stateRef.current.rows.some((r) => r.id === 'shift-closed-1')).toBe(true);
  });

  it('refuses a shift that has a break on it', async () => {
    stateRef.current.rows = [MANUAL_SHIFT];
    stateRef.current.breaks = [
      { ...OPEN_BREAK, id: 'break-1', shift_id: 'shift-manual-1', ended_at: '2026-08-09T13:00:00.000Z' },
    ];

    await expectRefused(
      adminVoidShift({ shiftId: 'shift-manual-1', actor: 'Kelly' }),
      'has-children',
    );
    expect(stateRef.current.rows).toHaveLength(1);
  });

  it('refuses a shift that has job time on it', async () => {
    stateRef.current.rows = [MANUAL_SHIFT];
    stateRef.current.segments = [
      { id: 'seg-1', shift_id: 'shift-manual-1', arrived_at: '2026-08-09T13:00:00.000Z', departed_at: null },
    ];

    await expectRefused(
      adminVoidShift({ shiftId: 'shift-manual-1', actor: 'Kelly' }),
      'has-children',
    );
    expect(stateRef.current.rows).toHaveLength(1);
  });

  it('refuses an id that matches no shift', async () => {
    await expectRefused(adminVoidShift({ shiftId: 'nobody', actor: 'Kelly' }), 'not-found');
  });

  it('refuses when the row changed between the read and the delete', async () => {
    stateRef.current.rows = [MANUAL_SHIFT];
    // The crew member reopens or an admin edits it in the gap: the CAS on
    // updated_at must match zero rows rather than delete a row the admin
    // never saw.
    stateRef.current.afterSelect = () => {
      stateRef.current.rows[0] = { ...MANUAL_SHIFT, updated_at: '2026-08-09T22:00:00.000Z' };
    };

    await expectRefused(
      adminVoidShift({ shiftId: 'shift-manual-1', actor: 'Kelly' }),
      'edit-race',
    );
    expect(stateRef.current.rows).toHaveLength(1);
  });

  it('writes the audit row BEFORE the delete, and refuses the void if it cannot be written', async () => {
    // The audit entry is the only copy of a deleted payroll row, so it cannot
    // be best-effort: if it fails, the row must survive. Supabase reports a
    // failed insert as { error }, it does not throw, so the guard has to read
    // that field rather than rely on a try/catch.
    stateRef.current.rows = [MANUAL_SHIFT];
    stateRef.current.activityError = { message: 'activity insert failed' };

    await expectRefused(
      adminVoidShift({ shiftId: 'shift-manual-1', actor: 'Kelly' }),
      'audit-failed',
    );
    expect(stateRef.current.rows).toHaveLength(1);
    expect(stateRef.current.deleted).toHaveLength(0);
  });

  it('corrects the trail when the audit lands but the delete loses its race', async () => {
    // The audit row is written first on purpose, so the mirror case is real:
    // the entry says a shift was removed and then the delete is refused. An
    // uncorrected entry is an audit trail that lies about payroll, which is
    // the same class the audit-first ordering exists to prevent (S78 wrap
    // delta-verify, which proved this empirically).
    stateRef.current.rows = [MANUAL_SHIFT];
    stateRef.current.afterSelect = () => {
      stateRef.current.rows[0] = { ...MANUAL_SHIFT, updated_at: '2026-08-09T22:00:00.000Z' };
    };

    await expectRefused(
      adminVoidShift({ shiftId: 'shift-manual-1', actor: 'Kelly' }),
      'edit-race',
    );

    expect(stateRef.current.rows).toHaveLength(1);
    const actions = stateRef.current.activityInserts.map((e) => e.action);
    expect(actions).toEqual(['shift-manual-void', 'shift-manual-void-aborted']);
    const correction = stateRef.current.activityInserts[1] as {
      detail: { shiftId: string; reason: string };
    };
    expect(correction.detail.shiftId).toBe('shift-manual-1');
    expect(correction.detail.reason).toBe('edit-race');
  });

  it('refuses when the child lookup fails, rather than deleting blind', async () => {
    stateRef.current.rows = [MANUAL_SHIFT];
    stateRef.current.childReadError = { message: 'db down' };

    await expectRefused(
      adminVoidShift({ shiftId: 'shift-manual-1', actor: 'Kelly' }),
      'has-children',
    );
    expect(stateRef.current.rows).toHaveLength(1);
  });
});

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
      closeSource: null,
      deviceTime: null,
      manualBy: null,
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
      closeSource: null,
      deviceTime: null,
      manualBy: null,
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
      closeSource: null,
      deviceTime: null,
      manualBy: null,
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
      close_source: null,
      device_time: null,
      manual_by: null,
      created_at: '2026-08-10T15:29:59.000Z',
      updated_at: '2026-08-10T15:29:59.000Z',
    };

    await expect(clockIn('crew-9', 'telegram')).resolves.toEqual({
      id: 'shift-race-1',
      crewMemberId: 'crew-9',
      clockInAt: '2026-08-10T15:29:59.000Z',
      clockOutAt: null,
      source: 'pwa',
      closeSource: null,
      deviceTime: null,
      manualBy: null,
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
      closeSource: 'office',
      deviceTime: null,
      manualBy: null,
      createdAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T15:30:00.000Z',
    });

    expect(stateRef.current.updated).toEqual([
      { clock_out_at: '2026-08-10T15:30:00.000Z', close_source: 'office' },
    ]);
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

  it('auto-closes a break still running, at the punch time, flagged for review', async () => {
    stateRef.current.breaks = [{ ...OPEN_BREAK }];

    await expect(clockOut('shift-open-1', 'crew-1', 'office')).resolves.toMatchObject({
      clockOutAt: '2026-08-10T15:30:00.000Z',
    });

    expect(stateRef.current.breakUpdates).toEqual([
      { ended_at: '2026-08-10T15:30:00.000Z', end_source: 'office', auto_closed: true },
    ]);
    expect(stateRef.current.breaks[0]).toMatchObject({
      ended_at: '2026-08-10T15:30:00.000Z',
      auto_closed: true,
    });
  });

  it('does not touch an already-ended break on clock-out', async () => {
    stateRef.current.breaks = [
      {
        ...OPEN_BREAK,
        ended_at: '2026-08-10T14:30:00.000Z',
        end_source: 'telegram',
      },
    ];

    await clockOut('shift-open-1', 'crew-1', 'office');

    expect(stateRef.current.breakUpdates).toEqual([]);
    expect(stateRef.current.breaks[0].ended_at).toBe('2026-08-10T14:30:00.000Z');
    expect(stateRef.current.breaks[0].auto_closed).toBe(false);
  });

  it('auto-closes a job segment still running, at the punch time, reason "other"', async () => {
    // A clock-out says the day ended, not that the job finished — recording
    // `completed` here would corrupt the budgeted-hours learning signal.
    stateRef.current.segments = [
      { id: 'seg-1', shift_id: 'shift-open-1', departed_at: null, stoppage_reason: null, auto_closed: false },
    ];

    await clockOut('shift-open-1', 'crew-1', 'office');

    expect(stateRef.current.segmentUpdates).toEqual([
      {
        departed_at: '2026-08-10T15:30:00.000Z',
        stoppage_reason: 'other',
        end_source: 'office',
        auto_closed: true,
      },
    ]);
  });

  it('closes BOTH a running break and a running segment on the same clock-out', async () => {
    stateRef.current.breaks = [{ ...OPEN_BREAK }];
    stateRef.current.segments = [
      { id: 'seg-1', shift_id: 'shift-open-1', departed_at: null, stoppage_reason: null, auto_closed: false },
    ];

    await clockOut('shift-open-1', 'crew-1', 'office');

    expect(stateRef.current.breakUpdates).toHaveLength(1);
    expect(stateRef.current.segmentUpdates).toHaveLength(1);
  });

  it('does not touch an already-departed segment', async () => {
    stateRef.current.segments = [
      {
        id: 'seg-1',
        shift_id: 'shift-open-1',
        departed_at: '2026-08-10T14:00:00.000Z',
        stoppage_reason: 'completed',
        auto_closed: false,
      },
    ];

    await clockOut('shift-open-1', 'crew-1', 'office');

    expect(stateRef.current.segmentUpdates).toEqual([]);
    expect(stateRef.current.segments[0].departed_at).toBe('2026-08-10T14:00:00.000Z');
  });

  it('does not attempt a break close when the clock-out itself was rejected', async () => {
    stateRef.current.breaks = [{ ...OPEN_BREAK }];

    await expect(clockOut('shift-open-1', 'crew-2', 'office')).rejects.toThrow(
      'clockOut: shift shift-open-1 belongs to crew-1, not crew-2',
    );

    expect(stateRef.current.breakUpdates).toEqual([]);
    expect(stateRef.current.breaks[0].ended_at).toBeNull();
  });
});
