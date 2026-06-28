// Contract: /api/admin/users is admin-only and validates input before touching
// the Supabase admin API (ledger #81 Slice 3). requireAdmin + the service client
// are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdmin, createUser, listUsers } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createUser: vi.fn(),
  listUsers: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireAdmin,
  roleOf: (m: { role?: unknown } | null | undefined) => (m?.role === 'admin' ? 'admin' : 'operator'),
}));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({ auth: { admin: { createUser, listUsers } } }),
}));

import { GET, POST } from './route';

const adminAuth = { operator: { id: 'admin1', email: 'a@x.com', role: 'admin' } };
const forbidden = { response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(adminAuth);
});

describe('GET /api/admin/users', () => {
  it('returns the gate response and never lists users for a non-admin', async () => {
    requireAdmin.mockResolvedValueOnce(forbidden);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('lists accounts for an admin', async () => {
    listUsers.mockResolvedValue({
      data: { users: [{ id: 'u1', email: 'a@x.com', app_metadata: { role: 'admin' } }] },
      error: null,
    });
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.users).toHaveLength(1);
    expect(json.users[0].role).toBe('admin');
  });
});

describe('POST /api/admin/users', () => {
  it('blocks a non-admin (no createUser call)', async () => {
    requireAdmin.mockResolvedValueOnce(forbidden);
    const res = await POST(makeReq({ email: 'new@x.com', password: 'longenough', role: 'operator' }));
    expect(res.status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('creates an account with email_confirm + role when admin and input valid', async () => {
    createUser.mockResolvedValue({
      data: { user: { id: 'u9', email: 'new@x.com', app_metadata: { role: 'operator' } } },
      error: null,
    });
    const res = await POST(makeReq({ email: 'new@x.com', password: 'longenough', role: 'operator' }));
    expect(res.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@x.com', email_confirm: true, app_metadata: { role: 'operator' } }),
    );
  });

  it('rejects a short password without calling Supabase', async () => {
    const res = await POST(makeReq({ email: 'new@x.com', password: 'short', role: 'operator' }));
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });
});
