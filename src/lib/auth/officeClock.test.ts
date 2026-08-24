// Direct unit tests for getOfficeClockCaller — the security-critical resolver
// that decides WHO an office clock punch is attributed to. The route tests mock
// it away, so these pin its own branches: fail-closed, crew rejection, and the
// linked/active checks. A punch mis-resolved here is a payroll integrity bug.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createRouteSupabase, isCrewAccount, getUser, maybeSingle, eq } = vi.hoisted(() => {
  const getUser = vi.fn();
  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  return {
    createRouteSupabase: vi.fn(),
    isCrewAccount: vi.fn(),
    getUser,
    maybeSingle,
    eq,
  };
});

vi.mock('@/lib/auth/supabaseServer', () => ({ createRouteSupabase, isCrewAccount }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({ from: () => ({ select: () => ({ eq }) }) }),
}));

import { getOfficeClockCaller } from './officeClock';

beforeEach(() => {
  vi.clearAllMocks();
  createRouteSupabase.mockResolvedValue({ auth: { getUser } });
  getUser.mockResolvedValue({ data: { user: { id: 'auth-1', app_metadata: {} } }, error: null });
  isCrewAccount.mockReturnValue(false);
  maybeSingle.mockResolvedValue({ data: { id: 'crew-1', display_name: 'Kelly', active: true }, error: null });
});

describe('getOfficeClockCaller', () => {
  it('resolves an active, linked operator to their pay identity, keyed on the SESSION id', async () => {
    const r = await getOfficeClockCaller();
    expect(r).toEqual({
      ok: true,
      caller: { crewMemberId: 'crew-1', authUserId: 'auth-1', displayName: 'Kelly' },
    });
    // The identity is resolved from the session's user id, never the body.
    expect(eq).toHaveBeenCalledWith('auth_user_id', 'auth-1');
  });

  it("fails 'unconfigured' when there is no route supabase (local/dev)", async () => {
    createRouteSupabase.mockResolvedValue(null);
    expect(await getOfficeClockCaller()).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it("fails CLOSED as 'unauthenticated' with no user / an auth error", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await getOfficeClockCaller()).toEqual({ ok: false, reason: 'unauthenticated' });
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    expect(await getOfficeClockCaller()).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it("REJECTS a crew login ('is_crew') BEFORE any crew_members lookup", async () => {
    isCrewAccount.mockReturnValue(true);
    expect(await getOfficeClockCaller()).toEqual({ ok: false, reason: 'is_crew' });
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("fails 'unlinked' when no crew_members row points at the login", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getOfficeClockCaller()).toEqual({ ok: false, reason: 'unlinked' });
  });

  it("fails 'inactive' when the linked crew member is deactivated", async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'crew-1', display_name: 'Kelly', active: false }, error: null });
    expect(await getOfficeClockCaller()).toEqual({ ok: false, reason: 'inactive' });
  });

  it("fails 'unconfigured' on a lookup error, without leaking who was asked for", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });
    expect(await getOfficeClockCaller()).toEqual({ ok: false, reason: 'unconfigured' });
  });
});
