// The account-creation door. What matters here: admin only; a minted login
// carries the advertising marker (never operator); a login that cannot be
// attached is rolled back, never left orphaned; password resets target the
// worker row's own auth id, never one from the body.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const {
  requireAdmin,
  createAdvertisingWorker,
  getAdvertisingWorker,
  listAdvertisingWorkers,
  setAdvertisingWorkerActive,
  logAdvertisingActivity,
  createUser,
  deleteUser,
  updateUserById,
  getUserById,
  updateBuilder,
} = vi.hoisted(() => {
  const updateBuilder = {
    payloads: [] as Record<string, unknown>[],
    result: { data: { id: 'worker-1' } as Record<string, unknown> | null, error: null as { message: string } | null },
  };
  return {
    requireAdmin: vi.fn(),
    createAdvertisingWorker: vi.fn(),
    getAdvertisingWorker: vi.fn(),
    listAdvertisingWorkers: vi.fn(),
    setAdvertisingWorkerActive: vi.fn(),
    logAdvertisingActivity: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    updateUserById: vi.fn(),
    getUserById: vi.fn(),
    updateBuilder,
  };
});

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/workers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/workers')>();
  return {
    ...actual,
    createAdvertisingWorker,
    getAdvertisingWorker,
    listAdvertisingWorkers,
    setAdvertisingWorkerActive,
  };
});
vi.mock('@/lib/advertising/activity', () => ({ logAdvertisingActivity }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    auth: { admin: { createUser, deleteUser, updateUserById, getUserById } },
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        updateBuilder.payloads.push(payload);
        const b = {
          eq: () => b,
          is: () => b,
          select: () => ({ maybeSingle: async () => updateBuilder.result }),
        };
        return b;
      },
    }),
  }),
}));

import { PATCH, POST } from './route';

const ADMIN = { operator: { id: 'admin-1', email: 'n@x.com', role: 'admin', name: 'Naldo' } };
const WORKER = {
  id: 'worker-1',
  displayName: 'Joe Signs',
  authUserId: null,
  active: true,
  isTest: false,
  createdAt: 'x',
  updatedAt: 'x',
};

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateBuilder.payloads.length = 0;
  updateBuilder.result = { data: { id: 'worker-1' }, error: null };
  requireAdmin.mockResolvedValue(ADMIN);
  createAdvertisingWorker.mockResolvedValue(WORKER);
  getAdvertisingWorker.mockResolvedValue(WORKER);
  listAdvertisingWorkers.mockResolvedValue([WORKER]);
  setAdvertisingWorkerActive.mockResolvedValue({ ...WORKER, active: false });
  createUser.mockResolvedValue({ data: { user: { id: 'auth-new-1' } }, error: null });
  deleteUser.mockResolvedValue({ error: null });
  updateUserById.mockResolvedValue({ error: null });
  getUserById.mockResolvedValue({ data: { user: { email: 'joe@x.com' } } });
});

describe('auth', () => {
  it('non-admins are refused before anything happens', async () => {
    requireAdmin.mockResolvedValue({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    const res = await POST(makeReq({ displayName: 'Joe' }));
    expect(res.status).toBe(403);
    expect(createAdvertisingWorker).not.toHaveBeenCalled();
  });
});

describe('POST — create worker (+ optional login)', () => {
  it('creates a worker with no login and logs worker_created with the admin as actor', async () => {
    const res = await POST(makeReq({ displayName: 'Joe Signs' }));
    expect(res.status).toBe(201);
    expect(createUser).not.toHaveBeenCalled();
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'admin-1', action: 'worker_created' }),
    );
  });

  it('mints the login with the ADVERTISING marker, never an operator role', async () => {
    const res = await POST(
      makeReq({ displayName: 'Joe Signs', email: 'joe@x.com', password: 'longenough' }),
    );
    expect(res.status).toBe(201);
    const meta = createUser.mock.calls[0][0].app_metadata as { role: string };
    expect(meta.role).toBe('advertising');
  });

  it('rolls the fresh login back when attaching loses the race', async () => {
    updateBuilder.result = { data: null, error: null }; // CAS miss
    const res = await POST(
      makeReq({ displayName: 'Joe Signs', email: 'joe@x.com', password: 'longenough' }),
    );
    expect(res.status).toBe(409);
    expect(deleteUser).toHaveBeenCalledWith('auth-new-1');
  });

  it('refuses bad credentials before creating anything', async () => {
    const res = await POST(makeReq({ displayName: 'Joe', email: 'joe@x.com', password: 'short' }));
    expect(res.status).toBe(400);
    expect(createAdvertisingWorker).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe('PATCH', () => {
  it('password reset targets the WORKER ROW\'s auth id, never one from the body', async () => {
    getAdvertisingWorker.mockResolvedValue({ ...WORKER, authUserId: 'auth-real' });
    const res = await PATCH(
      makeReq({ workerId: 'worker-1', password: 'newpassword', authUserId: 'auth-evil' }),
    );
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith('auth-real', { password: 'newpassword' });
  });

  it('refuses a password reset for a worker with no login', async () => {
    const res = await PATCH(makeReq({ workerId: 'worker-1', password: 'newpassword' }));
    expect(res.status).toBe(409);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('mints a login later for a row that has none, and refuses when one exists', async () => {
    let res = await PATCH(
      makeReq({ workerId: 'worker-1', email: 'joe@x.com', password: 'longenough' }),
    );
    expect(res.status).toBe(200);
    expect(createUser).toHaveBeenCalledTimes(1);

    getAdvertisingWorker.mockResolvedValue({ ...WORKER, authUserId: 'auth-real' });
    res = await PATCH(makeReq({ workerId: 'worker-1', email: 'j2@x.com', password: 'longenough' }));
    expect(res.status).toBe(409);
  });

  it('flips the active flag', async () => {
    const res = await PATCH(makeReq({ workerId: 'worker-1', active: false }));
    expect(res.status).toBe(200);
    expect(setAdvertisingWorkerActive).toHaveBeenCalledWith('worker-1', false);
  });
});
