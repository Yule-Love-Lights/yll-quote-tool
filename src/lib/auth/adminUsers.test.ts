import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toOperatorAccount, countAdmins, listOperatorAccounts, listNonCrewOperators } from './adminUsers';

describe('toOperatorAccount', () => {
  it('maps a Supabase user to the public account shape, deriving role safely', () => {
    expect(
      toOperatorAccount({
        id: 'u1',
        email: 'a@x.com',
        app_metadata: { role: 'admin', name: 'Ada Admin' },
        created_at: '2026-01-01T00:00:00Z',
        last_sign_in_at: '2026-06-01T00:00:00Z',
      }),
    ).toEqual({
      id: 'u1',
      email: 'a@x.com',
      role: 'admin',
      name: 'Ada Admin',
      createdAt: '2026-01-01T00:00:00Z',
      lastSignInAt: '2026-06-01T00:00:00Z',
    });
  });

  it('defaults a missing/forged role to operator and tolerates null fields', () => {
    const a = toOperatorAccount({ id: 'u2', app_metadata: { role: { nested: 'admin' } } });
    expect(a.role).toBe('operator');
    expect(a.email).toBeNull();
    expect(a.lastSignInAt).toBeNull();
    expect(a.name).toBeNull(); // no name in app_metadata → null (legacy account)
  });

  it('derives a trimmed name and nulls blank/forged names', () => {
    expect(toOperatorAccount({ id: 'u3', app_metadata: { name: '  Bob Op  ' } }).name).toBe('Bob Op');
    expect(toOperatorAccount({ id: 'u4', app_metadata: { name: '   ' } }).name).toBeNull();
    expect(toOperatorAccount({ id: 'u5', app_metadata: { name: { x: 1 } } }).name).toBeNull();
  });
});

describe('countAdmins', () => {
  it('counts only accounts whose role is exactly admin', () => {
    const accts = [
      { id: '1', email: null, role: 'admin' as const, name: null, createdAt: null, lastSignInAt: null },
      { id: '2', email: null, role: 'operator' as const, name: null, createdAt: null, lastSignInAt: null },
      { id: '3', email: null, role: 'admin' as const, name: null, createdAt: null, lastSignInAt: null },
    ];
    expect(countAdmins(accts)).toBe(2);
  });

  it('is 0 for an all-operator list', () => {
    expect(countAdmins([{ id: '1', email: null, role: 'operator', name: null, createdAt: null, lastSignInAt: null }])).toBe(0);
  });
});

describe('listOperatorAccounts', () => {
  it('follows nextPage and aggregates every page (so the admin count is complete)', async () => {
    // Names are deliberately in the OPPOSITE order from emails: user 1 (email b@)
    // is "Aaron", user 2 (email a@) is "Zoe". Name-first sort → [1, 2]; an email
    // sort would give [2, 1] — so this asserts the sort key is name (email fallback).
    const pages = [
      { data: { users: [{ id: '1', email: 'b@x.com', app_metadata: { role: 'admin', name: 'Aaron Admin' } }], nextPage: 2 }, error: null },
      { data: { users: [{ id: '2', email: 'a@x.com', app_metadata: { role: 'operator', name: 'Zoe Op' } }], nextPage: null }, error: null },
    ];
    const listUsers = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;

    const accounts = await listOperatorAccounts(sb);

    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(accounts.map((a) => a.id)).toEqual(['1', '2']); // sorted by name (Aaron then Zoe)
    expect(countAdmins(accounts)).toBe(1);
  });

  it('throws on a Supabase error', async () => {
    const listUsers = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;
    await expect(listOperatorAccounts(sb)).rejects.toThrow('boom');
  });
});

describe('listNonCrewOperators', () => {
  it('EXCLUDES crew logins so the office picker never offers one (raw-role check, before roleOf flattens crew to operator)', async () => {
    const pages = [
      {
        data: {
          users: [
            { id: 'op-1', email: 'ann@x.com', app_metadata: { role: 'operator', name: 'Ann' } },
            { id: 'crew-1', email: 'sonson@x.com', app_metadata: { role: 'crew', name: 'SonSon' } },
            { id: 'ad-1', email: 'naldo@x.com', app_metadata: { role: 'admin', name: 'Naldo' } },
          ],
          nextPage: null,
        },
        error: null,
      },
    ];
    const listUsers = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;

    const accounts = await listNonCrewOperators(sb);
    // The crew login is gone; only the operator + admin remain, sorted by name
    // ("Ann" < "Naldo").
    expect(accounts.map((a) => a.id)).toEqual(['op-1', 'ad-1']);
    expect(accounts.some((a) => a.id === 'crew-1')).toBe(false);
  });

  it('throws on a Supabase error', async () => {
    const listUsers = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;
    await expect(listNonCrewOperators(sb)).rejects.toThrow('boom');
  });
});
