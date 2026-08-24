import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import {
  roleOf,
  nameOf,
  getOperator,
  requireOperator,
  requireAdmin,
  withAuthFetchTimeout,
  authGateEngaged,
} from './supabaseServer';

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

// ─── nameOf — display name from app_metadata; null for legacy/forged ─────────
describe('nameOf', () => {
  it('returns the trimmed display name', () => {
    expect(nameOf({ name: '  Naldo Vasquez  ' })).toBe('Naldo Vasquez');
  });

  it('returns null for absent/blank/forged names (legacy accounts)', () => {
    for (const meta of [
      {},
      { name: '' },
      { name: '   ' },
      null,
      undefined,
      { name: { nested: 'x' } }, // can't spoof via an object
      { name: 123 },
      'Naldo', // app_metadata isn't a bare string
    ]) {
      expect(nameOf(meta)).toBeNull();
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

  it('maps an authenticated admin user (with name)', async () => {
    userRef.current = { id: 'u1', email: 'a@x.com', app_metadata: { role: 'admin', name: 'Ada Admin' } };
    expect(await getOperator()).toEqual({ id: 'u1', email: 'a@x.com', role: 'admin', name: 'Ada Admin' });
  });

  it('maps a non-admin user to operator, name null when unset (legacy)', async () => {
    userRef.current = { id: 'u2', email: 'b@x.com', app_metadata: {} };
    expect(await getOperator()).toEqual({ id: 'u2', email: 'b@x.com', role: 'operator', name: null });
  });

  it('fails closed when Supabase env is unconfigured', async () => {
    delete process.env.SUPABASE_URL;
    userRef.current = { id: 'u1', app_metadata: { role: 'admin' } };
    expect(await getOperator()).toBeNull();
  });
});

// ─── authGateEngaged — the single dormancy predicate (ledger #347) ──────────
// Engaged by DEFAULT; dormant ONLY on the explicit AUTH_GATE_ENABLED='false'
// opt-out. Deliberately NOT a function of whether Supabase env is configured —
// see the doc comment on authGateEngaged() for why that would be a new
// fail-open on a prod misconfig.
describe('authGateEngaged', () => {
  it('is engaged when the flag is unset (the new default)', () => {
    delete process.env.AUTH_GATE_ENABLED;
    expect(authGateEngaged()).toBe(true);
  });

  it('is engaged when the flag is exactly "true"', () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    expect(authGateEngaged()).toBe(true);
  });

  it('is engaged for any value other than the literal string "false" (e.g. a typo)', () => {
    process.env.AUTH_GATE_ENABLED = 'False';
    expect(authGateEngaged()).toBe(true);
  });

  it('is dormant ONLY when the flag is exactly "false"', () => {
    process.env.AUTH_GATE_ENABLED = 'false';
    expect(authGateEngaged()).toBe(false);
  });
});

// ─── requireOperator — dormancy-aware per-route guard ───────────────────────
// The per-route counterpart of the middleware perimeter. Engaged by default
// (ledger #347); dormant ONLY on the explicit AUTH_GATE_ENABLED='false' opt-out.
describe('requireOperator', () => {
  it('returns a 401 when the gate is engaged by DEFAULT (flag unset) and no operator is present', async () => {
    // gate flag unset (default in beforeEach) — must still enforce.
    userRef.current = null;
    const res = await requireOperator();
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('allows (returns null) when engaged by default and an operator is authenticated', async () => {
    userRef.current = { id: 'u1', email: 'a@x.com', app_metadata: { role: 'admin' } };
    expect(await requireOperator()).toBeNull();
  });

  it('returns a 401 response when the gate is explicitly "true" and no operator is present', async () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    userRef.current = null;
    const res = await requireOperator();
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('returns a 401 when the gate is engaged and the session is invalid', async () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    userRef.current = { id: 'u1' };
    userRef.error = { message: 'bad jwt' };
    const res = await requireOperator();
    expect(res?.status).toBe(401);
  });

  it('allows (returns null) when the gate is explicitly "true" and an operator is authenticated', async () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    userRef.current = { id: 'u1', email: 'a@x.com', app_metadata: { role: 'admin' } };
    expect(await requireOperator()).toBeNull();
  });

  it('allows (returns null) when deliberately opted OUT (AUTH_GATE_ENABLED=false) — even with no session', async () => {
    process.env.AUTH_GATE_ENABLED = 'false';
    userRef.current = null;
    expect(await requireOperator()).toBeNull();
  });

  it('does not even consult Supabase when deliberately opted out (works with env unset)', async () => {
    process.env.AUTH_GATE_ENABLED = 'false';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    userRef.current = null;
    expect(await requireOperator()).toBeNull();
  });

  // THE new-fail-open regression test: missing Supabase env must NOT be
  // treated as "can't check, so allow" — engaged-by-default + unconfigured
  // env must still 401, because getOperator() fails closed on a null client.
  it('fails CLOSED — not open — when engaged (default) and Supabase env is missing', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    userRef.current = { id: 'u1', app_metadata: { role: 'admin' } }; // would-be operator, irrelevant — no client to check them with
    const res = await requireOperator();
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });
});

// ─── requireAdmin — STRICT admin gate (never dormancy-bypassed) ──────────────
// Account-management routes always require a real admin session: there is no
// dormant use case, and allowing anonymous user CRUD would be a hole. So unlike
// requireOperator, requireAdmin does NOT consult AUTH_GATE_ENABLED.
describe('requireAdmin', () => {
  it('401s when there is no operator session', async () => {
    userRef.current = null;
    const r = await requireAdmin();
    expect('response' in r ? r.response.status : null).toBe(401);
  });

  it('403s when the operator is authenticated but not an admin', async () => {
    userRef.current = { id: 'u2', email: 'o@x.com', app_metadata: { role: 'operator' } };
    const r = await requireAdmin();
    expect('response' in r ? r.response.status : null).toBe(403);
  });

  it('returns the operator when an admin is authenticated', async () => {
    userRef.current = { id: 'u1', email: 'a@x.com', app_metadata: { role: 'admin', name: 'Ada Admin' } };
    const r = await requireAdmin();
    expect('operator' in r ? r.operator : null).toEqual({
      id: 'u1',
      email: 'a@x.com',
      role: 'admin',
      name: 'Ada Admin',
    });
  });

  it('still requires an admin while the gate is dormant (no AUTH_GATE_ENABLED bypass)', async () => {
    delete process.env.AUTH_GATE_ENABLED;
    userRef.current = null;
    const r = await requireAdmin();
    expect('response' in r ? r.response.status : null).toBe(401);
  });
});

// ─── withAuthFetchTimeout — #185 auth-gate fetch timeout ────────────────────
// auth-js has no built-in timeout on its GoTrue calls; this wrapper aborts a
// hung request after N ms (env-overridable) instead of letting it hang the
// whole request silently. SCOPE: only the two ANON-key SSR clients above use
// this — see the SCOPE comment on withAuthFetchTimeout in supabaseServer.ts.
describe('withAuthFetchTimeout', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.AUTH_FETCH_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = realFetch;
    delete process.env.AUTH_FETCH_TIMEOUT_MS;
  });

  it('resolves normally (and forwards a signal) when the underlying fetch completes before the timeout', async () => {
    const response = new Response('ok');
    const fetchSpy = vi.fn().mockResolvedValue(response);
    global.fetch = fetchSpy;

    const wrapped = withAuthFetchTimeout(5000);
    const result = await wrapped('https://x.supabase.co/auth/v1/user');

    expect(result).toBe(response);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('aborts and rejects once the explicit timeout elapses on a hung request, logging why', async () => {
    global.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const wrapped = withAuthFetchTimeout(1000);
    const pending = wrapped('https://x.supabase.co/auth/v1/user');
    const assertion = expect(pending).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('timed out after 1000ms'));
    errorSpy.mockRestore();
  });

  it('does NOT abort before the timeout elapses', async () => {
    global.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          setTimeout(() => resolve(new Response('ok')), 900);
        }),
    );

    const wrapped = withAuthFetchTimeout(1000);
    const pending = wrapped('https://x.supabase.co/auth/v1/user');
    await vi.advanceTimersByTimeAsync(900);
    await expect(pending).resolves.toBeInstanceOf(Response);
  });

  it('defaults to 5000ms when AUTH_FETCH_TIMEOUT_MS is unset', async () => {
    global.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const wrapped = withAuthFetchTimeout(); // no explicit arg -> reads env, falls back to 5000
    const pending = wrapped('https://x.supabase.co/auth/v1/user');
    const assertion = expect(pending).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('honors AUTH_FETCH_TIMEOUT_MS when set to a valid override', async () => {
    process.env.AUTH_FETCH_TIMEOUT_MS = '250';
    global.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const wrapped = withAuthFetchTimeout();
    const pending = wrapped('https://x.supabase.co/auth/v1/user');
    const assertion = expect(pending).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it('falls back to 5000ms when AUTH_FETCH_TIMEOUT_MS is not a valid positive number', async () => {
    process.env.AUTH_FETCH_TIMEOUT_MS = 'not-a-number';
    global.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const wrapped = withAuthFetchTimeout();
    const pending = wrapped('https://x.supabase.co/auth/v1/user');
    const assertion = expect(pending).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
