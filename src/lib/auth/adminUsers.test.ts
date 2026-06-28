import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toOperatorAccount, countAdmins, listOperatorAccounts } from './adminUsers';

describe('toOperatorAccount', () => {
  it('maps a Supabase user to the public account shape, deriving role safely', () => {
    expect(
      toOperatorAccount({
        id: 'u1',
        email: 'a@x.com',
        app_metadata: { role: 'admin' },
        created_at: '2026-01-01T00:00:00Z',
        last_sign_in_at: '2026-06-01T00:00:00Z',
      }),
    ).toEqual({
      id: 'u1',
      email: 'a@x.com',
      role: 'admin',
      createdAt: '2026-01-01T00:00:00Z',
      lastSignInAt: '2026-06-01T00:00:00Z',
    });
  });

  it('defaults a missing/forged role to operator and tolerates null fields', () => {
    const a = toOperatorAccount({ id: 'u2', app_metadata: { role: { nested: 'admin' } } });
    expect(a.role).toBe('operator');
    expect(a.email).toBeNull();
    expect(a.lastSignInAt).toBeNull();
  });
});

describe('countAdmins', () => {
  it('counts only accounts whose role is exactly admin', () => {
    const accts = [
      { id: '1', email: null, role: 'admin' as const, createdAt: null, lastSignInAt: null },
      { id: '2', email: null, role: 'operator' as const, createdAt: null, lastSignInAt: null },
      { id: '3', email: null, role: 'admin' as const, createdAt: null, lastSignInAt: null },
    ];
    expect(countAdmins(accts)).toBe(2);
  });

  it('is 0 for an all-operator list', () => {
    expect(countAdmins([{ id: '1', email: null, role: 'operator', createdAt: null, lastSignInAt: null }])).toBe(0);
  });
});

describe('listOperatorAccounts', () => {
  it('follows nextPage and aggregates every page (so the admin count is complete)', async () => {
    const pages = [
      { data: { users: [{ id: '1', email: 'b@x.com', app_metadata: { role: 'admin' } }], nextPage: 2 }, error: null },
      { data: { users: [{ id: '2', email: 'a@x.com', app_metadata: { role: 'operator' } }], nextPage: null }, error: null },
    ];
    const listUsers = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;

    const accounts = await listOperatorAccounts(sb);

    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(accounts.map((a) => a.id)).toEqual(['2', '1']); // sorted by email (a@ then b@)
    expect(countAdmins(accounts)).toBe(1);
  });

  it('throws on a Supabase error', async () => {
    const listUsers = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;
    await expect(listOperatorAccounts(sb)).rejects.toThrow('boom');
  });
});
