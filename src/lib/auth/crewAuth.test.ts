import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Meta = Record<string, unknown> | null;

const { userRef, crewRowRef, lookupErrorRef, dbConfiguredRef } = vi.hoisted(() => ({
  userRef: { current: null as { id: string; app_metadata: Meta } | null },
  crewRowRef: { current: null as { id: string; display_name: string; active: boolean } | null },
  lookupErrorRef: { current: null as { message: string } | null },
  dbConfiguredRef: { current: true },
}));

vi.mock('@/lib/auth/supabaseServer', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/supabaseServer')>('@/lib/auth/supabaseServer');
  return {
    // Keep the REAL isCrewAccount — it is the security seam under test, so
    // stubbing it would make these tests prove nothing.
    isCrewAccount: actual.isCrewAccount,
    CREW_ROLE: actual.CREW_ROLE,
    // Also real: one test asserts roleOf's behaviour to document WHY
    // isCrewAccount has to exist at all.
    roleOf: actual.roleOf,
    createRouteSupabase: async () => ({
      auth: {
        getUser: async () => ({
          data: { user: userRef.current },
          error: userRef.current ? null : { message: 'no session' },
        }),
      },
    }),
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () =>
    dbConfiguredRef.current
      ? {
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: crewRowRef.current,
                  error: lookupErrorRef.current,
                }),
              }),
            }),
          }),
        }
      : null,
}));

beforeEach(() => {
  userRef.current = null;
  crewRowRef.current = null;
  lookupErrorRef.current = null;
  dbConfiguredRef.current = true;
});

afterEach(() => vi.restoreAllMocks());

import { getCrewCaller, requireCrew } from './crewAuth';
import { CREW_ROLE, isCrewAccount, roleOf } from './supabaseServer';

// ---------------------------------------------------------------------------
// The security seam. Shared identity is NOT shared authorization.
// ---------------------------------------------------------------------------

describe('isCrewAccount — the seam that keeps crew off the operator surface', () => {
  it('recognises a crew account', () => {
    expect(isCrewAccount({ role: CREW_ROLE })).toBe(true);
  });

  it('does not treat operator, admin, missing, or forged metadata as crew', () => {
    expect(isCrewAccount({ role: 'operator' })).toBe(false);
    expect(isCrewAccount({ role: 'admin' })).toBe(false);
    expect(isCrewAccount({})).toBe(false);
    expect(isCrewAccount(null)).toBe(false);
    expect(isCrewAccount(undefined)).toBe(false);
    expect(isCrewAccount({ role: { nested: 'crew' } })).toBe(false);
  });

  it("documents WHY this exists: roleOf alone would call a crew account an operator", () => {
    // This is the hole. roleOf returns 'operator' for anything that is not
    // exactly 'admin', so without isCrewAccount a crew login would satisfy
    // requireOperator and reach /customers and its customer PII.
    expect(roleOf({ role: CREW_ROLE })).toBe('operator');
    expect(isCrewAccount({ role: CREW_ROLE })).toBe(true);
  });
});

describe('getCrewCaller', () => {
  it('rejects an anonymous request', async () => {
    await expect(getCrewCaller()).resolves.toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('rejects an OPERATOR session — an operator has no crew identity', async () => {
    userRef.current = { id: 'auth-op', app_metadata: { role: 'operator' } };
    await expect(getCrewCaller()).resolves.toEqual({ ok: false, reason: 'not_crew' });
  });

  it('rejects an ADMIN session too, rather than letting admin drive crew time', async () => {
    userRef.current = { id: 'auth-admin', app_metadata: { role: 'admin' } };
    await expect(getCrewCaller()).resolves.toEqual({ ok: false, reason: 'not_crew' });
  });

  it('rejects a crew login with no linked crew_members row', async () => {
    userRef.current = { id: 'auth-crew', app_metadata: { role: CREW_ROLE } };
    crewRowRef.current = null;
    await expect(getCrewCaller()).resolves.toEqual({ ok: false, reason: 'unlinked' });
  });

  it('rejects a deactivated crew member', async () => {
    userRef.current = { id: 'auth-crew', app_metadata: { role: CREW_ROLE } };
    crewRowRef.current = { id: 'crew-1', display_name: 'SonSon', active: false };
    await expect(getCrewCaller()).resolves.toEqual({ ok: false, reason: 'inactive' });
  });

  it('resolves an active linked crew member to their PAY identity', async () => {
    userRef.current = { id: 'auth-crew', app_metadata: { role: CREW_ROLE } };
    crewRowRef.current = { id: 'crew-1', display_name: 'SonSon', active: true };
    await expect(getCrewCaller()).resolves.toEqual({
      ok: true,
      caller: {
        crewMemberId: 'crew-1',
        authUserId: 'auth-crew',
        displayName: 'SonSon',
        active: true,
      },
    });
  });

  it('fails closed when the crew lookup errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    userRef.current = { id: 'auth-crew', app_metadata: { role: CREW_ROLE } };
    lookupErrorRef.current = { message: 'connection terminated' };
    await expect(getCrewCaller()).resolves.toEqual({ ok: false, reason: 'unconfigured' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fails closed when Supabase is not configured', async () => {
    userRef.current = { id: 'auth-crew', app_metadata: { role: CREW_ROLE } };
    dbConfiguredRef.current = false;
    await expect(getCrewCaller()).resolves.toEqual({ ok: false, reason: 'unconfigured' });
  });
});

describe('requireCrew', () => {
  it('is NEVER dormant — it denies with the gate flag off', async () => {
    // requireOperator returns null (allow) while AUTH_GATE_ENABLED is off,
    // because it was retrofitted onto pre-gate routes. These routes are new and
    // write payroll, so there is no dormant "anonymous clock-in" case.
    const prev = process.env.AUTH_GATE_ENABLED;
    delete process.env.AUTH_GATE_ENABLED;
    try {
      const result = await requireCrew();
      expect('response' in result).toBe(true);
      if ('response' in result) expect(result.response.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.AUTH_GATE_ENABLED;
      else process.env.AUTH_GATE_ENABLED = prev;
    }
  });

  it('403s an operator rather than 401ing, so the message is truthful', async () => {
    userRef.current = { id: 'auth-op', app_metadata: { role: 'operator' } };
    const result = await requireCrew();
    expect('response' in result).toBe(true);
    if ('response' in result) expect(result.response.status).toBe(403);
  });

  it('returns the caller when everything lines up', async () => {
    userRef.current = { id: 'auth-crew', app_metadata: { role: CREW_ROLE } };
    crewRowRef.current = { id: 'crew-1', display_name: 'SonSon', active: true };
    const result = await requireCrew();
    expect('caller' in result).toBe(true);
    if ('caller' in result) expect(result.caller.crewMemberId).toBe('crew-1');
  });
});
