import { describe, it, expect, vi, beforeEach } from 'vitest';

// getSessionRole gates ADMIN-ONLY pages (first user: /admin/fleet/clocks).
// Same mock shape as supabaseServer.test.ts, its sibling: every branch that is
// not a live admin or operator session must come back null (fail closed). The
// crew case is the S58 scar: roleOf collapses 'crew' to 'operator', so the
// isCrewAccount check running FIRST is load-bearing, not decorative.

const { userRef } = vi.hoisted(() => ({
  userRef: { current: null as unknown, error: null as unknown },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: userRef.current }, error: userRef.error }),
    },
  }),
}));

import { getSessionRole } from './sessionRole';

beforeEach(() => {
  userRef.current = null;
  userRef.error = null;
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon';
});

describe('getSessionRole', () => {
  it('returns null when Supabase env is unconfigured', async () => {
    delete process.env.SUPABASE_URL;
    userRef.current = { id: 'u1', app_metadata: { role: 'admin' } };
    expect(await getSessionRole()).toBeNull();
  });

  it('returns null when nobody is signed in', async () => {
    userRef.current = null;
    expect(await getSessionRole()).toBeNull();
  });

  it('returns null when getUser errors (invalid/expired session)', async () => {
    userRef.current = { id: 'u1', app_metadata: { role: 'admin' } };
    userRef.error = { message: 'bad jwt' };
    expect(await getSessionRole()).toBeNull();
  });

  it('returns null for a crew login even though roleOf would collapse it to operator', async () => {
    userRef.current = { id: 'u1', app_metadata: { role: 'crew' } };
    expect(await getSessionRole()).toBeNull();
  });

  it('returns null for an advertising login (same shared-store seam as crew)', async () => {
    userRef.current = { id: 'u5', app_metadata: { role: 'advertising' } };
    expect(await getSessionRole()).toBeNull();
  });

  it('returns operator for an ordinary operator login', async () => {
    userRef.current = { id: 'u2', app_metadata: {} };
    expect(await getSessionRole()).toBe('operator');
  });

  it("returns admin only for the exact string 'admin'", async () => {
    userRef.current = { id: 'u3', app_metadata: { role: 'admin' } };
    expect(await getSessionRole()).toBe('admin');
  });

  it('does not grant admin to a spoofed or near-miss role', async () => {
    for (const role of ['Admin', 'ADMIN', { nested: 'admin' }, 1, true]) {
      userRef.current = { id: 'u4', app_metadata: { role } };
      expect(await getSessionRole()).toBe('operator');
    }
  });
});
