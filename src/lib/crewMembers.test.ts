import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  hub_employee_id: string | null;
  telegram_user_id: string | null;
  // The fake DB must carry session_epoch, or the rotation this repo relies on
  // for "sign out everywhere" could be dropped from setStaffTelegram or
  // setStaffActive and no test here could see it (delta-verify, PR #1094).
  session_epoch: string | null;
  display_name: string;
  base_rate_cents: number;
  in_p4p_pool: boolean;
  pay_mode: 'hourly' | 'shadow' | 'p4p';
  language: string;
  active: boolean;
  is_office: boolean;
  auth_user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const CREW_1: Row = {
  id: 'crew-1',
  hub_employee_id: null,
  telegram_user_id: '111',
  session_epoch: null,
  display_name: 'SonSon',
  base_rate_cents: 1600,
  in_p4p_pool: true,
  pay_mode: 'shadow',
  language: 'en',
  active: true,
  is_office: false,
  auth_user_id: null,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

const CREW_2: Row = {
  id: 'crew-2',
  hub_employee_id: 'hub-2',
  telegram_user_id: '222',
  session_epoch: null,
  display_name: 'Big James',
  base_rate_cents: 2000,
  in_p4p_pool: true,
  pay_mode: 'shadow',
  language: 'es',
  active: true,
  is_office: false,
  auth_user_id: null,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

const CREW_3: Row = {
  id: 'crew-3',
  hub_employee_id: null,
  telegram_user_id: null,
  session_epoch: null,
  display_name: 'Inactive Jason',
  base_rate_cents: 1000,
  in_p4p_pool: false,
  pay_mode: 'hourly',
  language: 'en',
  active: false,
  is_office: false,
  auth_user_id: null,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

// Active but OFFICE staff — must be excluded from listActiveFieldCrew (job
// assignment) while still returned by listActiveCrewMembers (full roster).
const CREW_OFFICE: Row = {
  id: 'crew-office',
  hub_employee_id: null,
  telegram_user_id: null,
  session_epoch: null,
  display_name: 'Kelly',
  base_rate_cents: 2500,
  in_p4p_pool: false,
  pay_mode: 'hourly',
  language: 'en',
  active: true,
  is_office: true,
  auth_user_id: 'op-kelly',
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

const { dbRef, stateRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      rows: [] as Row[],
      error: null as { message: string } | null,
      inserted: [] as Record<string, unknown>[],
      updated: [] as Record<string, unknown>[],
      blockedDeleteIds: [] as string[],
      // The rate history (ledger row 506). Creating a staff member and
      // setting a rate BOTH write here now, so the mock has to model it or
      // every creation test dies on an unknown table — which is how these
      // tests proved the write is genuinely reached on both paths.
      rates: [] as Record<string, unknown>[],
      // Fails the rate write ALONE, so the half-created-staff-member path can
      // be exercised without also breaking the crew_members insert.
      rateUpsertError: null as { message: string } | null,
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));

function rowFromPayload(payload: Record<string, unknown>, id: string): Row {
  return {
    id,
    hub_employee_id: (payload.hub_employee_id as string | null | undefined) ?? null,
    telegram_user_id: (payload.telegram_user_id as string | null | undefined) ?? null,
    session_epoch: (payload.session_epoch as string | null | undefined) ?? null,
    display_name: String(payload.display_name),
    base_rate_cents: Number(payload.base_rate_cents),
    in_p4p_pool: Boolean(payload.in_p4p_pool),
    pay_mode: payload.pay_mode as Row['pay_mode'],
    language: String(payload.language ?? 'en'),
    active: payload.active === undefined ? true : Boolean(payload.active),
    is_office: payload.is_office === undefined ? false : Boolean(payload.is_office),
    auth_user_id: (payload.auth_user_id as string | null | undefined) ?? null,
    created_at: '2026-08-07T00:00:00.000Z',
    updated_at: '2026-08-07T00:00:00.000Z',
  };
}

function mergeRow(existing: Row, payload: Record<string, unknown>): Row {
  return {
    ...existing,
    hub_employee_id:
      payload.hub_employee_id === undefined ? existing.hub_employee_id : (payload.hub_employee_id as string | null),
    telegram_user_id:
      payload.telegram_user_id === undefined ? existing.telegram_user_id : (payload.telegram_user_id as string | null),
    session_epoch:
      payload.session_epoch === undefined ? existing.session_epoch : (payload.session_epoch as string | null),
    display_name: payload.display_name === undefined ? existing.display_name : String(payload.display_name),
    base_rate_cents:
      payload.base_rate_cents === undefined ? existing.base_rate_cents : Number(payload.base_rate_cents),
    in_p4p_pool: payload.in_p4p_pool === undefined ? existing.in_p4p_pool : Boolean(payload.in_p4p_pool),
    pay_mode: payload.pay_mode === undefined ? existing.pay_mode : (payload.pay_mode as Row['pay_mode']),
    language: payload.language === undefined ? existing.language : String(payload.language),
    active: payload.active === undefined ? existing.active : Boolean(payload.active),
    is_office: payload.is_office === undefined ? existing.is_office : Boolean(payload.is_office),
    auth_user_id:
      payload.auth_user_id === undefined ? existing.auth_user_id : (payload.auth_user_id as string | null),
    updated_at: '2026-08-07T00:00:00.000Z',
  };
}

function normalizeDisplayName(value: string): string {
  return value.trim().toLowerCase();
}

function makeDb() {
  return {
    from(table: string) {
      // The rate history, modelled just enough for setRateFrom: upsert a row,
      // list a person's rows oldest first. Deliberately NOT a second copy of
      // the resolver — crewMemberRates.test.ts owns that arithmetic; this
      // only has to let the writes through so the crew_members assertions
      // below still mean what they say.
      if (table === 'crew_member_rates') {
        const rateBuilder = {
          upsert: (payload: Record<string, unknown>) => {
            if (stateRef.current.rateUpsertError) {
              return Promise.resolve({ error: stateRef.current.rateUpsertError });
            }
            const i = stateRef.current.rates.findIndex(
              (r) =>
                r.crew_member_id === payload.crew_member_id &&
                r.effective_from === payload.effective_from,
            );
            if (i >= 0) stateRef.current.rates[i] = { ...stateRef.current.rates[i], ...payload };
            else
              stateRef.current.rates.push({
                id: `rate-${stateRef.current.rates.length + 1}`,
                created_at: '2026-09-04T00:00:00.000Z',
                ...payload,
              });
            return Promise.resolve({ error: stateRef.current.error });
          },
          select: () => rateBuilder,
          eq: (col: string, val: unknown) => {
            rateFiltered = rateFiltered.filter((r) => r[col] === val);
            return rateBuilder;
          },
          order: () =>
            Promise.resolve({
              data: [...rateFiltered].sort((a, b) =>
                String(a.effective_from) < String(b.effective_from) ? -1 : 1,
              ),
              error: stateRef.current.error,
            }),
        };
        let rateFiltered = [...stateRef.current.rates];
        return rateBuilder;
      }
      if (table !== 'crew_members') {
        throw new Error(`crewMembers.test.ts: unexpected table ${table}`);
      }

      let filtered = [...stateRef.current.rows];
      const builder = {
        select: () => builder,
        eq: (col: keyof Row, val: unknown) => {
          filtered = filtered.filter((row) => row[col] === val);
          return builder;
        },
        is: (col: keyof Row, val: unknown) => {
          if (val === null) filtered = filtered.filter((row) => row[col] === null);
          return builder;
        },
        // Case-insensitive exact match (no wildcards used against this column
        // in real code) — mirrors real Postgres ilike closely enough for the
        // race-recovery re-fetch this mock supports.
        ilike: (col: keyof Row, val: unknown) => {
          filtered = filtered.filter(
            (row) => String(row[col]).toLowerCase() === String(val).toLowerCase(),
          );
          return builder;
        },
        delete: () => ({
          eq: (col: keyof Row, val: unknown) => {
            const idx = stateRef.current.rows.findIndex((row) => row[col] === val);
            if (idx === -1) return Promise.resolve({ error: stateRef.current.error });
            // Modelled on the real schema: shifts / shift_breaks / job_segments /
            // job_assignments all reference crew_members with NO ACTION, so a row
            // with any recorded work makes Postgres refuse with 23503.
            if (stateRef.current.blockedDeleteIds.includes(String(val))) {
              return Promise.resolve({
                error: { code: '23503', message: 'violates foreign key constraint "shifts_crew_member_id_fkey"' },
              });
            }
            stateRef.current.rows.splice(idx, 1);
            return Promise.resolve({ error: null });
          },
        }),
        order: () => Promise.resolve({ data: filtered, error: stateRef.current.error }),
        maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: stateRef.current.error }),
        insert: (payload: Record<string, unknown>) => {
          stateRef.current.inserted.push(payload);
          // auth_user_id partial-unique index — modelled first so linkOfficeStaff's
          // auth-first error priority is exercised against realistic Postgres.
          if (payload.auth_user_id != null) {
            const authDuplicate = stateRef.current.rows.find(
              (row) => row.auth_user_id === payload.auth_user_id,
            );
            if (authDuplicate) {
              return {
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: null,
                      error: {
                        code: '23505',
                        message: 'duplicate key value violates unique constraint "crew_members_auth_user_id_key"',
                      },
                    }),
                }),
              };
            }
          }
          const duplicate = stateRef.current.rows.find(
            (row) => normalizeDisplayName(row.display_name) === normalizeDisplayName(String(payload.display_name)),
          );
          if (duplicate) {
            return {
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: null,
                    error: {
                      code: '23505',
                      message: 'duplicate key value violates unique constraint "crew_members_display_name_key"',
                    },
                  }),
              }),
            };
          }

          const row = rowFromPayload(payload, `generated-${stateRef.current.rows.length + 1}`);
          stateRef.current.rows.push(row);
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: row, error: stateRef.current.error }),
            }),
          };
        },
        update: (payload: Record<string, unknown>) => {
          stateRef.current.updated.push(payload);
          // Accumulate every chained .eq() filter, so both the single-filter
          // update (updateCrewMember: .eq('id')) and the by-construction office
          // guard (setOfficeStaffActive: .eq('id').eq('is_office', true)) resolve
          // against the SAME code path. The write only happens at maybeSingle().
          const filters: Array<[keyof Row, unknown]> = [];
          const resolve = (): { data: Row | null; error: { code?: string; message: string } | null } => {
            const idx = stateRef.current.rows.findIndex((row) =>
              filters.every(([col, val]) => row[col] === val),
            );
            if (idx === -1) return { data: null, error: stateRef.current.error };

            if (payload.display_name !== undefined) {
              const collision = stateRef.current.rows.find(
                (row, i) =>
                  i !== idx &&
                  normalizeDisplayName(row.display_name) === normalizeDisplayName(String(payload.display_name)),
              );
              if (collision) {
                return {
                  data: null,
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "crew_members_display_name_key"',
                  },
                };
              }
            }

            // The OTHER partial unique index on this table. Modelled here so the
            // telegram-collision path is exercised against realistic Postgres
            // behaviour rather than a hand-thrown error.
            if (payload.telegram_user_id !== undefined && payload.telegram_user_id !== null) {
              const collision = stateRef.current.rows.find(
                (row, i) => i !== idx && row.telegram_user_id === String(payload.telegram_user_id),
              );
              if (collision) {
                return {
                  data: null,
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "crew_members_telegram_user_id_key"',
                  },
                };
              }
            }

            const existing = stateRef.current.rows[idx];
            const row = mergeRow(existing, payload);
            stateRef.current.rows[idx] = row;
            return { data: row, error: stateRef.current.error };
          };

          const chain = {
            eq: (col: keyof Row, val: unknown) => {
              filters.push([col, val]);
              return chain;
            },
            // .is(col, null) is a FILTER like .eq, and the crew-door epoch mint
            // uses it as a compare-and-set on the null. Modelled here so that
            // CAS is exercised rather than mocked away.
            is: (col: keyof Row, val: unknown) => {
              filters.push([col, val]);
              return chain;
            },
            select: () => ({ maybeSingle: () => Promise.resolve(resolve()) }),
          };
          return chain;
        },
      };

      return builder;
    },
  };
}

beforeEach(() => {
  stateRef.current = {
    rows: [CREW_1, CREW_2, CREW_3],
    error: null,
    inserted: [],
    updated: [],
    blockedDeleteIds: [],
    rates: [],
    rateUpsertError: null,
  };
  dbRef.current = makeDb();
});

import {
  createFieldCrewMember,
  ensureCrewSessionEpoch,
  getCrewMember,
  getCrewMemberByTelegramUserId,
  rotateCrewSessionEpoch,
  insertCrewMember,
  linkOfficeStaff,
  listActiveCrewMembers,
  listActiveFieldCrew,
  listLinkedAuthUserIds,
  listAllStaff,
  OfficeDisplayNameTakenError,
  OperatorAlreadyLinkedError,
  setStaffActive,
  setStaffRate,
  setStaffTelegram,
  setStaffType,
  deleteStaffMember,
  getStaffMember,
  StaffHasRecordsError,
  TelegramUserIdTakenError,
  updateCrewMember,
} from './crewMembers';

describe('getCrewMember', () => {
  it('returns null when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(getCrewMember('crew-1')).resolves.toBeNull();
  });

  it('maps one row to camelCase by id', async () => {
    await expect(getCrewMember('crew-1')).resolves.toEqual({
      id: 'crew-1',
      hubEmployeeId: null,
      telegramUserId: '111',
      sessionEpoch: null,
      displayName: 'SonSon',
      baseRateCents: 1600,
      inP4pPool: true,
      payMode: 'shadow',
      language: 'en',
      active: true,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    });
  });

  it('returns null when the lookup misses or the query errors', async () => {
    await expect(getCrewMember('missing')).resolves.toBeNull();
    stateRef.current.error = { message: 'db down' };
    await expect(getCrewMember('crew-1')).resolves.toBeNull();
  });
});

describe('getCrewMemberByTelegramUserId', () => {
  it('returns null when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(getCrewMemberByTelegramUserId('111')).resolves.toBeNull();
  });

  it('trims the telegram id and maps one row', async () => {
    await expect(getCrewMemberByTelegramUserId(' 222 ')).resolves.toEqual({
      id: 'crew-2',
      hubEmployeeId: 'hub-2',
      telegramUserId: '222',
      sessionEpoch: null,
      displayName: 'Big James',
      baseRateCents: 2000,
      inP4pPool: true,
      payMode: 'shadow',
      language: 'es',
      active: true,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    });
  });
});

describe('listActiveCrewMembers', () => {
  it('returns [] when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(listActiveCrewMembers()).resolves.toEqual([]);
  });

  it('returns only active rows mapped to camelCase', async () => {
    await expect(listActiveCrewMembers()).resolves.toEqual([
      {
        id: 'crew-1',
        hubEmployeeId: null,
        telegramUserId: '111',
        sessionEpoch: null,
        displayName: 'SonSon',
        baseRateCents: 1600,
        inP4pPool: true,
        payMode: 'shadow',
        language: 'en',
        active: true,
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:00:00.000Z',
      },
      {
        id: 'crew-2',
        hubEmployeeId: 'hub-2',
        telegramUserId: '222',
        sessionEpoch: null,
        displayName: 'Big James',
        baseRateCents: 2000,
        inP4pPool: true,
        payMode: 'shadow',
        language: 'es',
        active: true,
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:00:00.000Z',
      },
    ]);
  });
});

describe('listActiveFieldCrew', () => {
  // null means the roster could NOT be read, so a caller can tell a load
  // failure apart from a genuinely empty crew list. An empty array used to
  // mean both, which rendered the schedule page's assign-crew dropdown empty
  // with nothing saying anything had failed (row 455, the same silent-empty
  // shape PR #1036 fixed on the geocoding fix-list).
  it('returns null when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(listActiveFieldCrew()).resolves.toBeNull();
  });

  it('returns null when the query fails, never an empty roster', async () => {
    stateRef.current.error = { message: 'db down' };
    await expect(listActiveFieldCrew()).resolves.toBeNull();
  });

  it('returns [] when the roster is genuinely empty', async () => {
    stateRef.current.rows = [];
    await expect(listActiveFieldCrew()).resolves.toEqual([]);
  });

  it('EXCLUDES active office staff (is_office) while listActiveCrewMembers keeps them', async () => {
    // Roster now includes an active OFFICE row (Kelly) alongside the field crew.
    stateRef.current.rows = [CREW_1, CREW_OFFICE, CREW_2, CREW_3];

    // Field-crew roster (job assignment): office staff excluded, inactive excluded.
    const field = await listActiveFieldCrew();
    expect(field?.map((c) => c.id)).toEqual(['crew-1', 'crew-2']);

    // Full roster (payroll): office staff STILL included — the office person must
    // not silently vanish from pay just because they are not dispatchable.
    const all = await listActiveCrewMembers();
    expect(all.map((c) => c.id)).toEqual(['crew-1', 'crew-office', 'crew-2']);
  });
});

describe('insertCrewMember', () => {
  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(
      insertCrewMember({
        displayName: 'Little James',
        baseRateCents: 1700,
        inP4pPool: true,
        payMode: 'shadow',
      }),
    ).rejects.toThrow('Supabase service role not configured');
  });

  it('inserts one row, trims mapped fields, and returns the created record', async () => {
    await expect(
      insertCrewMember({
        hubEmployeeId: null,
        telegramUserId: ' 333 ',
        displayName: 'Little James',
        baseRateCents: 1700,
        inP4pPool: true,
        payMode: 'shadow',
        language: 'en',
        active: true,
      }),
    ).resolves.toEqual({
      id: 'generated-4',
      hubEmployeeId: null,
      telegramUserId: '333',
      sessionEpoch: null,
      displayName: 'Little James',
      baseRateCents: 1700,
      inP4pPool: true,
      payMode: 'shadow',
      language: 'en',
      active: true,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    });

    expect(stateRef.current.inserted).toEqual([
      {
        hub_employee_id: null,
        telegram_user_id: '333',
        display_name: 'Little James',
        base_rate_cents: 1700,
        in_p4p_pool: true,
        pay_mode: 'shadow',
        language: 'en',
        active: true,
      },
    ]);
  });

  it('recovers the winner of a concurrent double insert instead of throwing (S57 fix)', async () => {
    // Was: the second call rejected with the raw Postgres unique-violation
    // error. A technical-lens session review caught that this is the EXACT
    // race migrations/2026-08-07-crew-members-name-unique.sql names as its
    // own threat model ("two concurrent calls to crewMembers.ts's insert
    // path with no id... could each create a second row for the same
    // human") — and shifts.ts's clockIn, written the same session, already
    // handles the identical shape correctly. This is the sibling-guard
    // parity fix: insertCrewMember now catches the unique violation and
    // re-fetches the winner, same as clockIn does.
    const first = await insertCrewMember({
      displayName: ' Little James ',
      baseRateCents: 1700,
      inP4pPool: true,
      payMode: 'shadow',
    });
    expect(first).toMatchObject({ id: 'generated-4', displayName: 'Little James' });

    await expect(
      insertCrewMember({
        displayName: ' Little James ',
        baseRateCents: 1700,
        inP4pPool: true,
        payMode: 'shadow',
      }),
    ).resolves.toEqual(first);

    // No second row was created — the race was recovered, not duplicated.
    expect(stateRef.current.rows).toHaveLength(4);
  });

  it('throws when Supabase returns an insert error', async () => {
    stateRef.current.error = { message: 'write failed' };
    await expect(
      insertCrewMember({
        displayName: 'Jason Balroop',
        baseRateCents: 1000,
        inP4pPool: false,
        payMode: 'hourly',
      }),
    ).rejects.toThrow('insertCrewMember: write failed');
  });
});

describe('updateCrewMember', () => {
  it('rejects a Telegram id that already belongs to another crew member, with a NAMED error', async () => {
    // CREW_1 (SonSon) already holds '111'. Giving it to crew-2 must not silently
    // succeed, and must not surface as a generic write failure — the office needs
    // to know it is a conflict they can resolve.
    await expect(updateCrewMember('crew-2', { telegramUserId: '111' })).rejects.toBeInstanceOf(
      TelegramUserIdTakenError,
    );
    await expect(updateCrewMember('crew-2', { telegramUserId: '111' })).rejects.toThrow(
      'Telegram account 111 is already linked to another crew member',
    );
  });

  it('links a free Telegram id, and unlinks with null', async () => {
    await expect(updateCrewMember('crew-2', { telegramUserId: '999' })).resolves.toMatchObject({
      id: 'crew-2',
      telegramUserId: '999',
    });
    await expect(updateCrewMember('crew-2', { telegramUserId: null })).resolves.toMatchObject({
      id: 'crew-2',
      telegramUserId: null,
    });
  });

  it('does NOT treat a re-link of the SAME id on the SAME row as a collision', async () => {
    // The partial index is on the column, so a no-op write of a row's own value
    // must not be mistaken for someone else's claim.
    await expect(updateCrewMember('crew-1', { telegramUserId: '111' })).resolves.toMatchObject({
      id: 'crew-1',
      telegramUserId: '111',
    });
  });

  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(
      updateCrewMember('crew-2', {
        telegramUserId: ' 333 ',
        displayName: ' Little James ',
        baseRateCents: 1700,
        inP4pPool: true,
        payMode: 'shadow',
        language: 'en',
        active: true,
      }),
    ).rejects.toThrow('Supabase service role not configured');
  });

  it('updates one existing row and returns the mapped result', async () => {
    await expect(
      updateCrewMember('crew-2', {
        hubEmployeeId: null,
        telegramUserId: ' 333 ',
        displayName: ' Little James ',
        baseRateCents: 1700,
        inP4pPool: true,
        payMode: 'shadow',
        language: 'en',
        active: true,
      }),
    ).resolves.toEqual({
      id: 'crew-2',
      hubEmployeeId: null,
      telegramUserId: '333',
      sessionEpoch: null,
      displayName: 'Little James',
      baseRateCents: 1700,
      inP4pPool: true,
      payMode: 'shadow',
      language: 'en',
      active: true,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    });

    // The mock merges the JS payload into the seed row; this proves field mapping, not Postgres partial-update semantics.
    expect(stateRef.current.updated).toEqual([
      {
        hub_employee_id: null,
        telegram_user_id: '333',
        display_name: 'Little James',
        base_rate_cents: 1700,
        in_p4p_pool: true,
        pay_mode: 'shadow',
        language: 'en',
        active: true,
      },
    ]);
  });

  it('throws clearly when the target id does not exist', async () => {
    await expect(
      updateCrewMember('missing-id', {
        displayName: 'Missing',
      }),
    ).rejects.toThrow('updateCrewMember: no row found for id missing-id');
  });

  it('rejects a rename to another crew member\'s name with a clear conflict error, never returning their row (S57 fix)', async () => {
    // Unlike insertCrewMember's race (recover the SAME person's winning row),
    // a rename collision here is a genuine conflict between two DIFFERENT
    // people — CREW_1 ("SonSon") tries to rename to CREW_2's ("Big James")
    // name. Silently "recovering" by returning CREW_2's row would hand back
    // someone else's pay data as if it were this update's result; the only
    // safe behavior is a clear, specific rejection.
    await expect(updateCrewMember('crew-1', { displayName: 'Big James' })).rejects.toThrow(
      'updateCrewMember: display name "Big James" is already in use by another crew member',
    );

    // Nothing was mutated by the rejected attempt.
    const untouched = stateRef.current.rows.find((row) => row.id === 'crew-1');
    expect(untouched?.display_name).toBe('SonSon');
  });
});

describe('listAllStaff', () => {
  it('returns [] when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(listAllStaff()).resolves.toEqual([]);
  });

  it('returns EVERY staff row, office and field alike, with the type as data', async () => {
    // One panel manages both populations now, so this deliberately does NOT
    // filter on is_office; the type is carried on each row as `isOffice`.
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    const all = await listAllStaff();
    expect(all.map((m) => [m.id, m.isOffice])).toEqual([
      ['crew-1', false],
      ['crew-office', true],
    ]);
  });

  it('returns [] and swallows a query error (never throws into the panel)', async () => {
    stateRef.current.error = { message: 'db down' };
    await expect(listAllStaff()).resolves.toEqual([]);
  });
});

describe('listLinkedAuthUserIds', () => {
  it('returns an empty set when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(listLinkedAuthUserIds()).resolves.toEqual(new Set());
  });

  it('collects every non-null auth_user_id across field crew AND office staff', async () => {
    // CREW_1/2/3 have null auth_user_id; only the office row is linked here.
    stateRef.current.rows = [CREW_1, CREW_2, CREW_3, CREW_OFFICE];
    const ids = await listLinkedAuthUserIds();
    expect(ids.has('op-kelly')).toBe(true);
    expect(ids.size).toBe(1);
  });
});

// Ledger row 506: a person's rate now lives in a HISTORY, and their
// crew_members.base_rate_cents is derived from it. A staff member created
// without a history row would have a rate on their row and no rate on any
// DAY, so every hour they work would be unpayable — the feature dead for
// exactly the people it was set up for.
describe('seeding the rate history when a staff member is created', () => {
  it('gives a new office staff member a first rate row, from far enough back to cover any shift', async () => {
    await linkOfficeStaff({ authUserId: 'op-new', displayName: 'Fresh', baseRateCents: 2500 });
    const seeded = stateRef.current.rates.filter((r) => r.rate_cents_per_hour === 2500);
    expect(seeded).toHaveLength(1);
    // A far-past day on purpose: a first row anchored to "when they were
    // added" would leave any backdated or imported shift with no rate at all.
    expect(seeded[0]!.effective_from).toBe('2000-01-01');
  });

  it('gives a new FIELD crew member one too — they clock in through the bot and still get paid', async () => {
    await createFieldCrewMember({ displayName: 'Fresh Field', baseRateCents: 1800 });
    expect(stateRef.current.rates.filter((r) => r.rate_cents_per_hour === 1800)).toHaveLength(1);
  });

  it('says the person WAS added when only the rate seed fails, and names where to finish it', async () => {
    // The raw error would read as "adding them failed", so the office would
    // try again and hit a duplicate name. Half-done has to say so.
    stateRef.current.rateUpsertError = { message: 'connection reset' };
    await expect(
      createFieldCrewMember({ displayName: 'Half Done', baseRateCents: 1800 }),
    ).rejects.toThrow(/Half Done was added, but their hourly rate could not be saved/);
    // The person really is there, which is what makes that message true.
    expect(stateRef.current.rows.some((r) => r.display_name === 'Half Done')).toBe(true);
  });
});

describe('linkOfficeStaff', () => {
  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(
      linkOfficeStaff({ authUserId: 'op-new', displayName: 'Ann', baseRateCents: 2500 }),
    ).rejects.toThrow('Supabase service role not configured');
  });

  it('creates an is_office, hourly, non-P4P row linked to the operator', async () => {
    stateRef.current.rows = [];
    const member = await linkOfficeStaff({ authUserId: 'op-ann', displayName: 'Ann', baseRateCents: 2500 });
    expect(member).toEqual({ id: 'generated-1', displayName: 'Ann', active: true, authUserId: 'op-ann', baseRateCents: 2500, telegramUserId: null, isOffice: true });

    const written = stateRef.current.inserted[0];
    expect(written).toMatchObject({
      display_name: 'Ann',
      base_rate_cents: 2500,
      is_office: true,
      auth_user_id: 'op-ann',
      pay_mode: 'hourly',
      in_p4p_pool: false,
      active: true,
    });
  });

  it('maps an auth_user_id collision to OperatorAlreadyLinkedError (the operator is already set up)', async () => {
    // CREW_OFFICE already holds auth_user_id 'op-kelly'.
    stateRef.current.rows = [CREW_OFFICE];
    await expect(
      linkOfficeStaff({ authUserId: 'op-kelly', displayName: 'Kelly Two', baseRateCents: 2500 }),
    ).rejects.toBeInstanceOf(OperatorAlreadyLinkedError);
  });

  it('maps a display-name collision to OfficeDisplayNameTakenError', async () => {
    stateRef.current.rows = [CREW_1]; // "SonSon", auth null
    await expect(
      linkOfficeStaff({ authUserId: 'op-new', displayName: 'SonSon', baseRateCents: 2500 }),
    ).rejects.toBeInstanceOf(OfficeDisplayNameTakenError);
  });
});

describe('setStaffActive', () => {
  it('throws when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(setStaffActive('crew-office', false)).rejects.toThrow(
      'Supabase service role not configured',
    );
  });

  it('deactivates an office row and returns the updated shape', async () => {
    stateRef.current.rows = [CREW_OFFICE];
    const member = await setStaffActive('crew-office', false);
    expect(member).toEqual({
      id: 'crew-office',
      displayName: 'Kelly',
      active: false,
      authUserId: 'op-kelly',
      baseRateCents: 2500,
      telegramUserId: null,
      isOffice: true,
    });
    expect(stateRef.current.rows.find((r) => r.id === 'crew-office')?.active).toBe(false);
  });

  it('deactivates a FIELD-crew row too — one door manages both populations', async () => {
    // Superseded the old office-only guard on purpose: field crew had no way to
    // be deactivated in-app at all, which is half of why the two panels differed.
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    const member = await setStaffActive('crew-1', false);
    expect(member?.isOffice).toBe(false);
    expect(stateRef.current.rows.find((r) => r.id === 'crew-1')?.active).toBe(false);
  });

  it('returns null for an id that matches no staff row at all', async () => {
    stateRef.current.rows = [CREW_OFFICE];
    await expect(setStaffActive('nobody', false)).resolves.toBeNull();
  });
});

describe('setStaffRate', () => {
  it('updates an office row rate (integer cents) and returns the updated shape', async () => {
    stateRef.current.rows = [CREW_OFFICE];
    const member = await setStaffRate('crew-office', 3000);
    expect(member).toEqual({
      id: 'crew-office',
      displayName: 'Kelly',
      active: true,
      authUserId: 'op-kelly',
      baseRateCents: 3000,
      telegramUserId: null,
      isOffice: true,
    });
    expect(stateRef.current.rows.find((r) => r.id === 'crew-office')?.base_rate_cents).toBe(3000);
  });

  it('edits a FIELD-crew rate too — crew rows previously showed no rate at all', async () => {
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    const member = await setStaffRate('crew-1', 9999);
    expect(member?.baseRateCents).toBe(9999);
    expect(stateRef.current.rows.find((r) => r.id === 'crew-1')?.base_rate_cents).toBe(9999);
  });
});

describe('setStaffTelegram', () => {
  it('links a Telegram id on an OFFICE row — office staff text the bot too', async () => {
    stateRef.current.rows = [CREW_OFFICE];
    const member = await setStaffTelegram('crew-office', '987654321');
    expect(member?.telegramUserId).toBe('987654321');
    expect(stateRef.current.rows.find((r) => r.id === 'crew-office')?.telegram_user_id).toBe('987654321');
  });

  it('unlinks on null', async () => {
    stateRef.current.rows = [{ ...CREW_OFFICE, telegram_user_id: '987654321' }];
    const member = await setStaffTelegram('crew-office', null);
    expect(member?.telegramUserId).toBeNull();
  });

  it('maps a collision with ANOTHER member to TelegramUserIdTakenError, never returning their row', async () => {
    // CREW_1 (field crew) already holds '111'. Handing it to the office row
    // would split one Telegram account across two pay identities.
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    await expect(setStaffTelegram('crew-office', '111')).rejects.toBeInstanceOf(
      TelegramUserIdTakenError,
    );
    expect(stateRef.current.rows.find((r) => r.id === 'crew-office')?.telegram_user_id).toBeNull();
  });

  it('relinks a FIELD-crew Telegram id through the same door', async () => {
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    const member = await setStaffTelegram('crew-1', '999');
    expect(member?.telegramUserId).toBe('999');
    expect(stateRef.current.rows.find((r) => r.id === 'crew-1')?.telegram_user_id).toBe('999');
  });
});

describe('setStaffType', () => {
  it('moves a field row to office, which is what takes them off the assignable roster', async () => {
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    const member = await setStaffType('crew-1', true);
    expect(member?.isOffice).toBe(true);
    // listActiveFieldCrew is the flag's only functional reader, so the point of
    // the move is that they stop appearing there.
    const field = await listActiveFieldCrew();
    expect(field?.map((c) => c.id)).not.toContain('crew-1');
  });

  it('moves an office row to field, the recovery direction this exists for', async () => {
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    const member = await setStaffType('crew-office', false);
    expect(member?.isOffice).toBe(false);
    const field = await listActiveFieldCrew();
    expect(field?.map((c) => c.id)).toContain('crew-office');
  });

  it('returns null for an id that matches no staff row', async () => {
    stateRef.current.rows = [CREW_OFFICE];
    await expect(setStaffType('nobody', true)).resolves.toBeNull();
  });
});

describe('deleteStaffMember', () => {
  it('removes a row that has no work behind it, and hands back what was deleted', async () => {
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    const removed = await deleteStaffMember('crew-office');
    expect(removed?.displayName).toBe('Kelly');
    expect(removed?.authUserId).toBe('op-kelly'); // caller needs this to clean up a crew login
    expect(stateRef.current.rows.map((r) => r.id)).toEqual(['crew-1']);
  });

  it('REFUSES anyone with recorded time, because the database refuses it (23503)', async () => {
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    stateRef.current.blockedDeleteIds = ['crew-1'];
    await expect(deleteStaffMember('crew-1')).rejects.toBeInstanceOf(StaffHasRecordsError);
    // Nothing was removed — their payroll history keeps them alive.
    expect(stateRef.current.rows.map((r) => r.id)).toEqual(['crew-1', 'crew-office']);
  });

  it('names the person in the refusal and points at Deactivate instead', async () => {
    stateRef.current.rows = [CREW_1];
    stateRef.current.blockedDeleteIds = ['crew-1'];
    await expect(deleteStaffMember('crew-1')).rejects.toThrow(/SonSon[\s\S]*Deactivate/);
  });

  it('returns null for an id that matches nothing, without deleting anything', async () => {
    stateRef.current.rows = [CREW_1];
    await expect(deleteStaffMember('nobody')).resolves.toBeNull();
    expect(stateRef.current.rows).toHaveLength(1);
  });
});

describe('getStaffMember', () => {
  it('finds a row in either population and maps it', async () => {
    stateRef.current.rows = [CREW_1, CREW_OFFICE];
    expect((await getStaffMember('crew-1'))?.isOffice).toBe(false);
    expect((await getStaffMember('crew-office'))?.isOffice).toBe(true);
    await expect(getStaffMember('nobody')).resolves.toBeNull();
  });
});

// The rotation these two writes perform is the whole revocation story for My
// Day sessions (PR #1094). Before this block the fake DB did not even carry
// session_epoch, so dropping the rotation would have broken nothing here.
describe('session epoch rotation', () => {
  it('rotates on link AND on unlink, so relinking the SAME account still signs old sessions out', async () => {
    const before = stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch;
    await setStaffTelegram('crew-1', '900001');
    const afterLink = stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch;
    expect(afterLink).toBeTruthy();
    expect(afterLink).not.toBe(before);

    await setStaffTelegram('crew-1', null);
    const afterUnlink = stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch;
    expect(afterUnlink).not.toBe(afterLink);

    await setStaffTelegram('crew-1', '900001');
    const afterRelink = stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch;
    expect(afterRelink).not.toBe(afterUnlink);
    expect(afterRelink).not.toBe(afterLink);
  });

  it('rotates when a staff member is deactivated', async () => {
    const before = stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch;
    await setStaffActive('crew-1', false);
    expect(stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch).not.toBe(before);
  });

  it('leaves the epoch alone on reactivation, because no session can be minted while inactive', async () => {
    await setStaffActive('crew-1', false);
    const afterDeactivate = stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch;
    await setStaffActive('crew-1', true);
    expect(stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch).toBe(afterDeactivate);
  });

  it('rotateCrewSessionEpoch changes it and returns the new value', async () => {
    const before = stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch;
    const epoch = await rotateCrewSessionEpoch('crew-1');
    expect(epoch).toBeTruthy();
    expect(epoch).not.toBe(before);
    expect(stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch).toBe(epoch);
  });

  it('ensureCrewSessionEpoch mints once and is stable afterwards', async () => {
    const first = await ensureCrewSessionEpoch('crew-1');
    expect(first).toBeTruthy();
    await expect(ensureCrewSessionEpoch('crew-1')).resolves.toBe(first);
  });
});

describe('ensureCrewSessionEpoch races', () => {
  // Two entries racing the FIRST use must agree on one epoch: if both minted,
  // one crew member's brand-new session would be invalidated at birth.
  it('two concurrent first entries settle on the same epoch', async () => {
    const [a, b] = await Promise.all([ensureCrewSessionEpoch('crew-1'), ensureCrewSessionEpoch('crew-1')]);
    expect(a).toBe(b);
    expect(stateRef.current.rows.find((r) => r.id === 'crew-1')!.session_epoch).toBe(a);
  });
});
