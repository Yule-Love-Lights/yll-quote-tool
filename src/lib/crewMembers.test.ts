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

  it('surfaces a duplicate-display-name unique-constraint failure on retry', async () => {
    await expect(
      insertCrewMember({
        displayName: ' Little James ',
        baseRateCents: 1700,
        inP4pPool: true,
        payMode: 'shadow',
      }),
    ).resolves.toMatchObject({
      id: 'generated-4',
      displayName: 'Little James',
    });

    await expect(
      insertCrewMember({
        displayName: ' Little James ',
        baseRateCents: 1700,
        inP4pPool: true,
        payMode: 'shadow',
      }),
    ).rejects.toThrow('insertCrewMember: duplicate key value violates unique constraint "crew_members_display_name_key"');
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
});
