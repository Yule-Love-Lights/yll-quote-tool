import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  hub_employee_id: string | null;
  telegram_user_id: string | null;
  display_name: string;
  base_rate_cents: number;
  in_p4p_pool: boolean;
  pay_mode: 'hourly' | 'shadow' | 'p4p';
  language: string;
  active: boolean;
  is_office: boolean;
  created_at: string | null;
  updated_at: string | null;
};

const CREW_1: Row = {
  id: 'crew-1',
  hub_employee_id: null,
  telegram_user_id: '111',
  display_name: 'SonSon',
  base_rate_cents: 1600,
  in_p4p_pool: true,
  pay_mode: 'shadow',
  language: 'en',
  active: true,
  is_office: false,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

const CREW_2: Row = {
  id: 'crew-2',
  hub_employee_id: 'hub-2',
  telegram_user_id: '222',
  display_name: 'Big James',
  base_rate_cents: 2000,
  in_p4p_pool: true,
  pay_mode: 'shadow',
  language: 'es',
  active: true,
  is_office: false,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

const CREW_3: Row = {
  id: 'crew-3',
  hub_employee_id: null,
  telegram_user_id: null,
  display_name: 'Inactive Jason',
  base_rate_cents: 1000,
  in_p4p_pool: false,
  pay_mode: 'hourly',
  language: 'en',
  active: false,
  is_office: false,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

// Active but OFFICE staff — must be excluded from listActiveFieldCrew (job
// assignment) while still returned by listActiveCrewMembers (full roster).
const CREW_OFFICE: Row = {
  id: 'crew-office',
  hub_employee_id: null,
  telegram_user_id: null,
  display_name: 'Kelly',
  base_rate_cents: 2500,
  in_p4p_pool: false,
  pay_mode: 'hourly',
  language: 'en',
  active: true,
  is_office: true,
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
    display_name: String(payload.display_name),
    base_rate_cents: Number(payload.base_rate_cents),
    in_p4p_pool: Boolean(payload.in_p4p_pool),
    pay_mode: payload.pay_mode as Row['pay_mode'],
    language: String(payload.language ?? 'en'),
    active: payload.active === undefined ? true : Boolean(payload.active),
    is_office: payload.is_office === undefined ? false : Boolean(payload.is_office),
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
    display_name: payload.display_name === undefined ? existing.display_name : String(payload.display_name),
    base_rate_cents:
      payload.base_rate_cents === undefined ? existing.base_rate_cents : Number(payload.base_rate_cents),
    in_p4p_pool: payload.in_p4p_pool === undefined ? existing.in_p4p_pool : Boolean(payload.in_p4p_pool),
    pay_mode: payload.pay_mode === undefined ? existing.pay_mode : (payload.pay_mode as Row['pay_mode']),
    language: payload.language === undefined ? existing.language : String(payload.language),
    active: payload.active === undefined ? existing.active : Boolean(payload.active),
    is_office: payload.is_office === undefined ? existing.is_office : Boolean(payload.is_office),
    updated_at: '2026-08-07T00:00:00.000Z',
  };
}

function normalizeDisplayName(value: string): string {
  return value.trim().toLowerCase();
}

function makeDb() {
  return {
    from(table: string) {
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
        order: () => Promise.resolve({ data: filtered, error: stateRef.current.error }),
        maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: stateRef.current.error }),
        insert: (payload: Record<string, unknown>) => {
          stateRef.current.inserted.push(payload);
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
          return {
            eq: (col: keyof Row, val: unknown) => {
              const idx = stateRef.current.rows.findIndex((row) => row[col] === val);
              if (idx === -1) {
                return {
                  select: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: stateRef.current.error }),
                  }),
                };
              }

              if (payload.display_name !== undefined) {
                const collision = stateRef.current.rows.find(
                  (row, i) =>
                    i !== idx &&
                    normalizeDisplayName(row.display_name) === normalizeDisplayName(String(payload.display_name)),
                );
                if (collision) {
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
                    select: () => ({
                      maybeSingle: () =>
                        Promise.resolve({
                          data: null,
                          error: {
                            code: '23505',
                            message:
                              'duplicate key value violates unique constraint "crew_members_telegram_user_id_key"',
                          },
                        }),
                    }),
                  };
                }
              }

              const existing = stateRef.current.rows[idx];
              const row = mergeRow(existing, payload);
              stateRef.current.rows[idx] = row;

              return {
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: row, error: stateRef.current.error }),
                }),
              };
            },
          };
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
  };
  dbRef.current = makeDb();
});

import {
  getCrewMember,
  getCrewMemberByTelegramUserId,
  insertCrewMember,
  listActiveCrewMembers,
  listActiveFieldCrew,
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
  it('returns [] when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(listActiveFieldCrew()).resolves.toEqual([]);
  });

  it('EXCLUDES active office staff (is_office) while listActiveCrewMembers keeps them', async () => {
    // Roster now includes an active OFFICE row (Kelly) alongside the field crew.
    stateRef.current.rows = [CREW_1, CREW_OFFICE, CREW_2, CREW_3];

    // Field-crew roster (job assignment): office staff excluded, inactive excluded.
    const field = await listActiveFieldCrew();
    expect(field.map((c) => c.id)).toEqual(['crew-1', 'crew-2']);

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
