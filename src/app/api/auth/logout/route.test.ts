// Tests for POST /api/auth/logout (#81 operator auth exit point / W6-004). Must:
// sign out via the session client when Supabase is configured, and no-op 200
// when it isn't (never throw / 500 on an already-unauthenticated or
// unconfigured environment). Also clears the staff-device cookie (WT-62) so a
// repurposed device stops suppressing a real customer's own view signals.
// Supabase mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STAFF_DEVICE_COOKIE } from '@/lib/auth/staffDevice';

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

  it('WT-62: clears the staff-device cookie so a repurposed device stops suppressing a real customer view', async () => {
    const res = await POST();
    const cookie = res.cookies.get(STAFF_DEVICE_COOKIE);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });
});
