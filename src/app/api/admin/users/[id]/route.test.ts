// Contract: /api/admin/users/[id] is admin-only and enforces the self-delete /
// self-role-change guards before touching Supabase (ledger #81 Slice 3).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdmin, getUserById, deleteUser, updateUserById, listUsers } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getUserById: vi.fn(),
  deleteUser: vi.fn(),
  updateUserById: vi.fn(),
  listUsers: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireAdmin,
  roleOf: (m: { role?: unknown } | null | undefined) => (m?.role === 'admin' ? 'admin' : 'operator'),
}));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    auth: { admin: { getUserById, deleteUser, updateUserById, listUsers } },
  }),
}));

import { DELETE, PATCH } from './route';

const ADMIN1 = '11111111-1111-1111-1111-111111111111';
const OP2 = '22222222-2222-2222-2222-222222222222';
const adminAuth = { operator: { id: ADMIN1, email: 'a@x.com', role: 'admin' } };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const makeReq = (body: unknown) => ({ json: async () => body } as unknown as NextRequest);

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(adminAuth);
  listUsers.mockResolvedValue({
    data: {
      users: [
        { id: ADMIN1, app_metadata: { role: 'admin' } },
        { id: OP2, app_metadata: { role: 'operator' } },
      ],
      nextPage: null,
    },
    error: null,
  });
});

describe('DELETE /api/admin/users/[id]', () => {
  it('blocks a non-admin caller', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await DELETE(makeReq(null), params(OP2));
    expect(res.status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('refuses self-deletion (400) and never calls deleteUser', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: ADMIN1, app_metadata: { role: 'admin' } } }, error: null });
    const res = await DELETE(makeReq(null), params(ADMIN1));
    expect(res.status).toBe(400);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('deletes another operator', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: OP2, app_metadata: { role: 'operator' } } }, error: null });
    deleteUser.mockResolvedValue({ error: null });
    const res = await DELETE(makeReq(null), params(OP2));
    expect(res.status).toBe(200);
    expect(deleteUser).toHaveBeenCalledWith(OP2);
  });
});

describe('PATCH /api/admin/users/[id]', () => {
  it('refuses changing your own role (400) and never updates', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: ADMIN1, app_metadata: { role: 'admin' } } }, error: null });
    const res = await PATCH(makeReq({ role: 'operator' }), params(ADMIN1));
    expect(res.status).toBe(400);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('promotes another operator to admin', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: OP2, app_metadata: { role: 'operator' } } }, error: null });
    updateUserById.mockResolvedValue({ data: { user: { id: OP2, email: 'o@x.com', app_metadata: { role: 'admin' } } }, error: null });
    const res = await PATCH(makeReq({ role: 'admin' }), params(OP2));
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith(OP2, expect.objectContaining({ app_metadata: expect.objectContaining({ role: 'admin' }) }));
  });
});

describe('malformed :id', () => {
  // The Supabase admin SDK throws (outside its try/catch) on a non-UUID id; the
  // route must reject it cleanly (404) BEFORE calling Supabase, never a 500 leak.
  it('PATCH returns 404 for a non-UUID id without calling Supabase', async () => {
    const res = await PATCH(makeReq({ role: 'admin' }), params('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(getUserById).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('DELETE returns 404 for a non-UUID id without calling Supabase', async () => {
    const res = await DELETE(makeReq(null), params('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(getUserById).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
