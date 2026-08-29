import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  toOperatorAccount,
  countAdmins,
  listOperatorAccounts,
  listNonCrewOperators,
  matchOperatorByEmail,
  findOperatorByEmail,
  type OperatorAccount,
} from './adminUsers';

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

  // Advertising role hardening (technical-lens fix round): the same trap as
  // crew above. Without this exclusion, an advertising login would be offered
  // as an "eligible operator" in the Staff panel's office-onboarding picker
  // and could be linked to a crew_members pay row like a real operator.
  it('EXCLUDES advertising logins too, for the same reason as crew (raw-role check, before roleOf flattens it to operator)', async () => {
    const pages = [
      {
        data: {
          users: [
            { id: 'op-1', email: 'ann@x.com', app_metadata: { role: 'operator', name: 'Ann' } },
            { id: 'crew-1', email: 'sonson@x.com', app_metadata: { role: 'crew', name: 'SonSon' } },
            { id: 'ad-1', email: 'agency@x.com', app_metadata: { role: 'advertising', name: 'Agency' } },
          ],
          nextPage: null,
        },
        error: null,
      },
    ];
    const listUsers = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;

    const accounts = await listNonCrewOperators(sb);
    expect(accounts.map((a) => a.id)).toEqual(['op-1']);
    expect(accounts.some((a) => a.id === 'crew-1')).toBe(false);
    expect(accounts.some((a) => a.id === 'ad-1')).toBe(false);
  });
});

describe('matchOperatorByEmail (rep-assignment ruling)', () => {
  const ann: OperatorAccount = { id: 'op-1', email: 'Ann@x.com', role: 'operator', name: 'Ann', createdAt: null, lastSignInAt: null };
  const bob: OperatorAccount = { id: 'op-2', email: 'bob@x.com', role: 'admin', name: 'Bob', createdAt: null, lastSignInAt: null };

  it('matches on exact email', () => {
    expect(matchOperatorByEmail([ann, bob], 'bob@x.com')).toEqual(bob);
  });

  it('matches case-insensitively on both sides', () => {
    expect(matchOperatorByEmail([ann, bob], 'ANN@X.COM')).toEqual(ann);
    expect(matchOperatorByEmail([ann, bob], 'ann@x.com')).toEqual(ann); // stored email has a capital A
  });

  it('returns null for no match', () => {
    expect(matchOperatorByEmail([ann, bob], 'nobody@x.com')).toBeNull();
  });

  it('returns null for a null/empty/whitespace-only email rather than matching an operator with a null email', () => {
    const noEmail: OperatorAccount = { id: 'op-3', email: null, role: 'operator', name: null, createdAt: null, lastSignInAt: null };
    expect(matchOperatorByEmail([noEmail], null)).toBeNull();
    expect(matchOperatorByEmail([noEmail], '')).toBeNull();
    expect(matchOperatorByEmail([noEmail], '   ')).toBeNull();
  });
});

describe('findOperatorByEmail (rep-assignment ruling)', () => {
  it('matches a rep email against the non-crew, non-advertising population', async () => {
    const pages = [
      {
        data: {
          users: [
            { id: 'op-1', email: 'ann@x.com', app_metadata: { role: 'operator', name: 'Ann' } },
          ],
          nextPage: null,
        },
        error: null,
      },
    ];
    const listUsers = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;

    const result = await findOperatorByEmail(sb, 'ANN@x.com');
    expect(result?.id).toBe('op-1');
  });

  it('EXCLUDES a crew account even when its email matches — a rep email must never auto-assign a crew login', async () => {
    const pages = [
      {
        data: {
          users: [
            // A crew login happens to share the exact email a rep's GHL user
            // record resolved to.
            { id: 'crew-1', email: 'shared@x.com', app_metadata: { role: 'crew', name: 'Crew Person' } },
          ],
          nextPage: null,
        },
        error: null,
      },
    ];
    const listUsers = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;

    const result = await findOperatorByEmail(sb, 'shared@x.com');
    expect(result).toBeNull();
  });

  it('returns null without calling listUsers for a null/empty email', async () => {
    const listUsers = vi.fn();
    const sb = { auth: { admin: { listUsers } } } as unknown as SupabaseClient;
    expect(await findOperatorByEmail(sb, null)).toBeNull();
    expect(await findOperatorByEmail(sb, '')).toBeNull();
    expect(listUsers).not.toHaveBeenCalled();
  });
});
