// Tests for POST /api/auth/logout (#81 operator auth exit point / W6-004). Must:
// sign out via the session client when Supabase is configured, and no-op 200
// when it isn't (never throw / 500 on an already-unauthenticated or
// unconfigured environment). Supabase mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { signOut, createRouteSupabaseMock } = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ error: null })),
  createRouteSupabaseMock: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ createRouteSupabase: createRouteSupabaseMock }));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  createRouteSupabaseMock.mockResolvedValue({ auth: { signOut } });
});

describe('POST /api/auth/logout', () => {
  it('signs out via the session client when Supabase is configured', async () => {
    const res = await POST();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('no-ops 200 (does not throw) when Supabase is not configured', async () => {
    createRouteSupabaseMock.mockResolvedValueOnce(null);
    const res = await POST();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
  });
});
