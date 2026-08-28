// Contract: /api/admin/users/[id] is admin-only and enforces the self-delete /
// self-role-change guards before touching Supabase (ledger #81 Slice 3).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdmin, getUserById, deleteUser, updateUserById, listUsers, clearStaffLoginByAuthUserId } = vi.hoisted(() => ({
  clearStaffLoginByAuthUserId: vi.fn(),
  requireAdmin: vi.fn(),
  getUserById: vi.fn(),
  deleteUser: vi.fn(),
  updateUserById: vi.fn(),
  listUsers: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireAdmin,
  roleOf: (m: { role?: unknown } | null | undefined) => (m?.role === 'admin' ? 'admin' : 'operator'),
  nameOf: (m: { name?: unknown } | null | undefined) =>
    typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : null,
  // Real behaviour, not a stub: this is the guard that keeps a crew login from
  // being promoted to admin through this route, so faking it would defeat the
  // test below.
  isCrewAccount: (m: { role?: unknown } | null | undefined) => m?.role === 'crew',
  // Same reason, for the advertising guard tested below.
  isAdvertisingAccount: (m: { role?: unknown } | null | undefined) => m?.role === 'advertising',
}));
vi.mock('@/lib/crewMembers', () => ({ clearStaffLoginByAuthUserId }));
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
  clearStaffLoginByAuthUserId.mockResolvedValue(null);
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

const CREW_USER = '33333333-3333-3333-3333-333333333333';

describe('DELETE /api/admin/users/[id] — crew logins are refused here', () => {
  // Without this guard the delete SUCCEEDS: roleOf collapses 'crew' to
  // 'operator', so canDeleteUser sees an ordinary operator and permits it.
  // The damage is not the lost login — it is that crew_members.auth_user_id has
  // no FK to auth.users, so the pointer survives the delete and no route can
  // clear it. crew-accounts POST then 409s "already has a login" forever.
  it('REFUSES to delete a crew login (403), and never calls deleteUser', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: CREW_USER, app_metadata: { role: 'crew', name: 'SonSon' } } },
      error: null,
    });

    const res = await DELETE(makeReq(null), params(CREW_USER));

    expect(res.status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('still deletes an ordinary operator, so the guard is narrow', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator' } } },
      error: null,
    });
    deleteUser.mockResolvedValue({ error: null });

    const res = await DELETE(makeReq(null), params(OP2));

    expect(res.status).toBe(200);
    expect(deleteUser).toHaveBeenCalledWith(OP2);
  });
});

describe('PATCH /api/admin/users/[id] — crew logins are refused here', () => {
  it('REFUSES to promote a crew login to admin (403), and updates nothing', async () => {
    // Before the guard this returned 200 and the account became a real admin
    // with access to /customers: roleOf collapses 'crew' to 'operator', so the
    // role change looked like an ordinary operator promotion, and the metadata
    // spread erased the crew marker. (S58 wrap review, security lens.)
    getUserById.mockResolvedValue({
      data: { user: { id: CREW_USER, app_metadata: { role: 'crew', name: 'SonSon' } } },
      error: null,
    });

    const res = await PATCH(makeReq({ role: 'admin' }), { params: Promise.resolve({ id: CREW_USER }) });

    expect(res.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('refuses any PATCH of a crew login, not just a role change', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: CREW_USER, app_metadata: { role: 'crew', name: 'SonSon' } } },
      error: null,
    });

    const res = await PATCH(makeReq({ name: 'New Name' }), {
      params: Promise.resolve({ id: CREW_USER }),
    });

    expect(res.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

const ADVERTISING_USER = '44444444-4444-4444-4444-444444444444';

describe('DELETE /api/admin/users/[id] — advertising logins are refused here (advertising role hardening)', () => {
  // Same trap as crew: without this guard the delete SUCCEEDS, because roleOf
  // collapses 'advertising' to 'operator' and canDeleteUser sees an ordinary
  // operator. No advertising account exists yet, but this door refuses one
  // from day one.
  it('REFUSES to delete an advertising login (403), and never calls deleteUser', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: ADVERTISING_USER, app_metadata: { role: 'advertising' } } },
      error: null,
    });

    const res = await DELETE(makeReq(null), params(ADVERTISING_USER));

    expect(res.status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('still deletes an ordinary operator, so the guard is narrow', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator' } } },
      error: null,
    });
    deleteUser.mockResolvedValue({ error: null });

    const res = await DELETE(makeReq(null), params(OP2));

    expect(res.status).toBe(200);
    expect(deleteUser).toHaveBeenCalledWith(OP2);
  });
});

describe('PATCH /api/admin/users/[id] — advertising logins are refused here (advertising role hardening)', () => {
  it('REFUSES to promote an advertising login to admin (403), and updates nothing', async () => {
    // Before the guard this would return 200 and the account would become a
    // real admin: roleOf collapses 'advertising' to 'operator', so the role
    // change looks like an ordinary operator promotion, and the metadata
    // spread would erase the advertising marker.
    getUserById.mockResolvedValue({
      data: { user: { id: ADVERTISING_USER, app_metadata: { role: 'advertising' } } },
      error: null,
    });

    const res = await PATCH(makeReq({ role: 'admin' }), { params: Promise.resolve({ id: ADVERTISING_USER }) });

    expect(res.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('refuses any PATCH of an advertising login, not just a role change', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: ADVERTISING_USER, app_metadata: { role: 'advertising' } } },
      error: null,
    });

    const res = await PATCH(makeReq({ name: 'New Name' }), {
      params: Promise.resolve({ id: ADVERTISING_USER }),
    });

    expect(res.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe('PATCH name (#81 display names)', () => {
  it('updates the name and PRESERVES the role (metadata merge, not clobber)', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator', name: 'Old Name' } } },
      error: null,
    });
    updateUserById.mockResolvedValue({
      data: { user: { id: OP2, email: 'o@x.com', app_metadata: { role: 'operator', name: 'New Name' } } },
      error: null,
    });
    const res = await PATCH(makeReq({ name: 'New Name' }), params(OP2));
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith(
      OP2,
      expect.objectContaining({ app_metadata: { role: 'operator', name: 'New Name' } }),
    );
  });

  it('backfills a name onto a legacy account that never had one', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator' } } },
      error: null,
    });
    updateUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator', name: 'Backfilled' } } },
      error: null,
    });
    const res = await PATCH(makeReq({ name: 'Backfilled' }), params(OP2));
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith(
      OP2,
      expect.objectContaining({ app_metadata: { role: 'operator', name: 'Backfilled' } }),
    );
  });

  it('updates name AND role together, preserving both', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator' } } },
      error: null,
    });
    updateUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'admin', name: 'Both' } } },
      error: null,
    });
    const res = await PATCH(makeReq({ name: 'Both', role: 'admin' }), params(OP2));
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith(
      OP2,
      expect.objectContaining({ app_metadata: { role: 'admin', name: 'Both' } }),
    );
  });

  it('PRESERVES an existing name on a role-only PATCH (no clobber)', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator', name: 'Keep Me' } } },
      error: null,
    });
    updateUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'admin', name: 'Keep Me' } } },
      error: null,
    });
    const res = await PATCH(makeReq({ role: 'admin' }), params(OP2));
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith(
      OP2,
      expect.objectContaining({ app_metadata: { role: 'admin', name: 'Keep Me' } }),
    );
  });

  it('rejects a blank name (400) without calling updateUserById', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator' } } },
      error: null,
    });
    const res = await PATCH(makeReq({ name: '   ' }), params(OP2));
    expect(res.status).toBe(400);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('treats a name-only body as a valid update (not "nothing to update")', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator' } } },
      error: null,
    });
    updateUserById.mockResolvedValue({
      data: { user: { id: OP2, app_metadata: { role: 'operator', name: 'Solo' } } },
      error: null,
    });
    const res = await PATCH(makeReq({ name: 'Solo' }), params(OP2));
    expect(res.status).toBe(200);
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

describe('DELETE detaches a linked staff row first (ledger row 359)', () => {
  it('clears the pay row pointer BEFORE deleting the login, and names who was detached', async () => {
    // crew_members.auth_user_id has no FK to auth.users, so without this the
    // pointer survives as a dangling id and the person cannot be given a new
    // login: POST /api/admin/staff refuses because the column is truthy.
    const order: string[] = [];
    clearStaffLoginByAuthUserId.mockImplementationOnce(async () => {
      order.push('detach');
      return { id: 'crew-office', displayName: 'Kelly', authUserId: null };
    });
    deleteUser.mockImplementationOnce(async () => {
      order.push('delete');
      return { error: null };
    });

    const res = await DELETE(makeReq(null), params(OP2));
    expect(res.status).toBe(200);
    expect(order).toEqual(['detach', 'delete']);
    expect(clearStaffLoginByAuthUserId).toHaveBeenCalledWith(OP2);
    expect((await res.json()).detachedStaffMember).toEqual({ id: 'crew-office', displayName: 'Kelly' });
  });

  it('reports null when no staff row pointed at that login, which is the common case', async () => {
    const res = await DELETE(makeReq(null), params(OP2));
    expect(res.status).toBe(200);
    expect((await res.json()).detachedStaffMember).toBeNull();
  });

  it('leaves the login intact if the detach itself fails, rather than deleting into a dangling pointer', async () => {
    clearStaffLoginByAuthUserId.mockRejectedValueOnce(new Error('db down'));
    const res = await DELETE(makeReq(null), params(OP2));
    expect(res.status).toBe(500);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
