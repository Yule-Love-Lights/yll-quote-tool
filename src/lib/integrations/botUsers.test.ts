// Tests for the bot roster data layer + resolveSenderRole. The security-critical
// property: the DB roster and the env floor combine by taking the HIGHER role,
// so a bad roster edit can never demote a bootstrap admin out of access.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
  isSupabaseServiceConfigured: () => dbRef.current !== null,
}));

import { roleFromDb, resolveSenderRole, listBotUsers } from './botUsers';

type Row = Record<string, unknown>;

// Minimal PostgREST-ish fake covering only what these functions use:
// from().select().eq().maybeSingle() and from().select().order().
function makeDb(rows: Row[]) {
  return {
    from() {
      let filtered = rows;
      const builder = {
        select: () => builder,
        order: () => Promise.resolve({ data: filtered, error: null }),
        eq: (col: string, val: unknown) => {
          filtered = rows.filter((r) => String(r[col]) === String(val));
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      };
      return builder;
    },
  };
}

const ENV_KEYS = ['TELEGRAM_ADMIN_USERS', 'TELEGRAM_STAFF_USERS', 'TELEGRAM_CREW_USERS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dbRef.current = null;
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('roleFromDb', () => {
  it('returns the roster role for a known id', async () => {
    dbRef.current = makeDb([{ telegram_user_id: '111', role: 'staff' }]);
    expect(await roleFromDb('111')).toBe('staff');
  });
  it('returns null for an unknown id, empty id, or no client', async () => {
    dbRef.current = makeDb([{ telegram_user_id: '111', role: 'staff' }]);
    expect(await roleFromDb('999')).toBeNull();
    expect(await roleFromDb('')).toBeNull();
    dbRef.current = null;
    expect(await roleFromDb('111')).toBeNull();
  });
});

describe('resolveSenderRole (DB + env floor)', () => {
  it('uses the DB role when there is no env entry', async () => {
    dbRef.current = makeDb([{ telegram_user_id: '111', role: 'staff' }]);
    expect(await resolveSenderRole('111')).toBe('staff');
  });

  it('takes the HIGHER of DB and env — the roster can elevate', async () => {
    process.env.TELEGRAM_CREW_USERS = '111';
    dbRef.current = makeDb([{ telegram_user_id: '111', role: 'admin' }]);
    expect(await resolveSenderRole('111')).toBe('admin');
  });

  it('takes the HIGHER of DB and env — the roster can NOT demote a bootstrap admin', async () => {
    process.env.TELEGRAM_ADMIN_USERS = '111';
    dbRef.current = makeDb([{ telegram_user_id: '111', role: 'crew' }]);
    expect(await resolveSenderRole('111')).toBe('admin');
  });

  it('falls back to the env role when the id is absent from the roster', async () => {
    process.env.TELEGRAM_STAFF_USERS = '222';
    dbRef.current = makeDb([]);
    expect(await resolveSenderRole('222')).toBe('staff');
  });

  it('defaults an unassigned sender to crew (allowlisted-chat least privilege)', async () => {
    dbRef.current = makeDb([]);
    expect(await resolveSenderRole('999')).toBe('crew');
  });

  it('defaults to crew when Supabase is unavailable and there is no env entry', async () => {
    dbRef.current = null;
    expect(await resolveSenderRole('999')).toBe('crew');
  });
});

describe('listBotUsers', () => {
  it('returns [] when Supabase is not configured', async () => {
    dbRef.current = null;
    expect(await listBotUsers()).toEqual([]);
  });
  it('maps rows to camelCase BotUser', async () => {
    dbRef.current = makeDb([
      { telegram_user_id: '111', display_name: 'Mike', role: 'crew', added_by: 'a@x.com', created_at: 't', updated_at: 't' },
    ]);
    const users = await listBotUsers();
    expect(users).toEqual([
      { telegramUserId: '111', displayName: 'Mike', role: 'crew', addedBy: 'a@x.com', createdAt: 't', updatedAt: 't' },
    ]);
  });
});
