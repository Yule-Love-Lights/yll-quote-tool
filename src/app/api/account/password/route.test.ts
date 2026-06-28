// Contract: POST /api/account/password lets the LOGGED-IN operator change their
// OWN password (any role), via their own session — never anyone else's, never a
// role. requireAdmin is NOT involved. getOperator + the session client mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const { getOperator, updateUser } = vi.hoisted(() => ({
  getOperator: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  getOperator,
  createRouteSupabase: async () => ({ auth: { updateUser } }),
}));

import { POST } from './route';

const makeReq = (body: unknown) => ({ json: async () => body } as unknown as NextRequest);

beforeEach(() => {
  vi.clearAllMocks();
  getOperator.mockResolvedValue({ id: 'u1', email: 'o@x.com', role: 'operator' });
  updateUser.mockResolvedValue({ data: {}, error: null });
});

describe('POST /api/account/password — self password change', () => {
  it('401s when nobody is logged in (no update)', async () => {
    getOperator.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ password: 'longenough' }));
    expect(res.status).toBe(401);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('400s for a short password (no update)', async () => {
    const res = await POST(makeReq({ password: 'short' }));
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('changes the password for the logged-in operator via their own session', async () => {
    const res = await POST(makeReq({ password: 'longenough' }));
    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith({ password: 'longenough' });
  });

  it('surfaces a Supabase update error as 400', async () => {
    updateUser.mockResolvedValueOnce({ data: {}, error: { message: 'weak' } });
    const res = await POST(makeReq({ password: 'longenough' }));
    expect(res.status).toBe(400);
  });
});
