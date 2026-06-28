import { describe, it, expect, vi, beforeEach } from 'vitest';

// #81 auth perimeter — the security-relevant logic of the SSR auth module:
// roleOf (no self-elevation) + getOperator (session → operator, fail-closed).

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

import { roleOf, getOperator, requireOperator } from './supabaseServer';

beforeEach(() => {
  userRef.current = null;
  userRef.error = null;
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon';
  delete process.env.AUTH_GATE_ENABLED;
});

// ─── roleOf — admin ONLY when exactly 'admin'; no self-elevation ────────────
describe('roleOf', () => {
  it("returns admin only for the exact string 'admin'", () => {
    expect(roleOf({ role: 'admin' })).toBe('admin');
  });

  it('defaults everything else to operator', () => {
    for (const meta of [
      { role: 'operator' },
      {},
      null,
      undefined,
      { role: 'Admin' }, // case-sensitive
      { role: 'ADMIN' },
      { role: true },
      { role: 1 },
      { role: { nested: 'admin' } }, // can't spoof via an object
      { roles: ['admin'] }, // wrong key
      'admin', // app_metadata isn't a bare string
    ]) {
      expect(roleOf(meta)).toBe('operator');
    }
  });
});

// ─── getOperator — session → operator, fail-closed ──────────────────────────
describe('getOperator', () => {
  it('returns null when there is no authenticated user', async () => {
    userRef.current = null;
    expect(await getOperator()).toBeNull();
  });

  it('returns null when getUser errors (invalid/expired session)', async () => {
    userRef.current = { id: 'u1' };
    userRef.error = { message: 'bad jwt' };
    expect(await getOperator()).toBeNull();
  });

  it('maps an authenticated admin user', async () => {
    userRef.current = { id: 'u1', email: 'a@x.com', app_metadata: { role: 'admin' } };
    expect(await getOperator()).toEqual({ id: 'u1', email: 'a@x.com', role: 'admin' });
  });

  it('maps an authenticated non-admin user to operator', async () => {
    userRef.current = { id: 'u2', email: 'b@x.com', app_metadata: {} };
    expect(await getOperator()).toEqual({ id: 'u2', email: 'b@x.com', role: 'operator' });
  });

  it('fails closed when Supabase env is unconfigured', async () => {
    delete process.env.SUPABASE_URL;
    userRef.current = { id: 'u1', app_metadata: { role: 'admin' } };
    expect(await getOperator()).toBeNull();
  });
});

// ─── requireOperator — dormancy-aware per-route guard ───────────────────────
// The per-route counterpart of the middleware perimeter. DORMANT unless
// AUTH_GATE_ENABLED==='true', so adding it to routes is a no-op until go-live —
// critical because the Supabase auth env isn't configured until Slice 4, and a
// hard getOperator() gate would 401 every operator route while still dormant.
describe('requireOperator', () => {
  it('allows (returns null) when the gate is dormant — even with no session', async () => {
    // gate off (default in beforeEach)
    userRef.current = null;
    expect(await requireOperator()).toBeNull();
  });

  it('does not even consult Supabase when dormant (works with env unset)', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    userRef.current = null;
    expect(await requireOperator()).toBeNull();
  });

  it('returns a 401 response when the gate is enabled and no operator is present', async () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    userRef.current = null;
    const res = await requireOperator();
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('returns a 401 when the gate is enabled and the session is invalid', async () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    userRef.current = { id: 'u1' };
    userRef.error = { message: 'bad jwt' };
    const res = await requireOperator();
    expect(res?.status).toBe(401);
  });

  it('allows (returns null) when the gate is enabled and an operator is authenticated', async () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    userRef.current = { id: 'u1', email: 'a@x.com', app_metadata: { role: 'admin' } };
    expect(await requireOperator()).toBeNull();
  });
});
