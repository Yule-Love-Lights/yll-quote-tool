// Contract: /api/admin/staff is the ONE admin door for every staff member,
// office and field. It replaces /api/admin/crew-accounts and
// /api/admin/office-staff, whose suites this ports forward, plus the password
// reset neither of them had. The real dollarsToCents and telegram validators are
// used, so money and id parsing are exercised end to end rather than mocked.
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdmin,
  sbRef,
  listAllStaff,
  listLinkedAuthUserIds,
  linkOfficeStaff,
  createFieldCrewMember,
  linkStaffLogin,
  setStaffActive,
  setStaffRate,
  setStaffTelegram,
  listNonCrewOperators,
  listAllAccountsById,
  OperatorAlreadyLinkedError,
  OfficeDisplayNameTakenError,
  TelegramUserIdTakenError,
} = vi.hoisted(() => {
  // Real error subclasses so the route's instanceof mapping is tested for the
  // right reason (a plain object would fall through to the wrong branch).
  class OperatorAlreadyLinkedError extends Error {
    constructor() {
      super('That operator is already set up as staff.');
      this.name = 'OperatorAlreadyLinkedError';
    }
  }
  class OfficeDisplayNameTakenError extends Error {
    constructor(displayName: string) {
      super(`The name "${displayName}" is already in use by another staff member.`);
      this.name = 'OfficeDisplayNameTakenError';
    }
  }
  class TelegramUserIdTakenError extends Error {
    constructor(id: string) {
      super(`Telegram account ${id} is already linked to another crew member`);
      this.name = 'TelegramUserIdTakenError';
    }
  }
  return {
    requireAdmin: vi.fn(),
    sbRef: { current: {} as unknown },
    listAllStaff: vi.fn(),
    listLinkedAuthUserIds: vi.fn(),
    linkOfficeStaff: vi.fn(),
    createFieldCrewMember: vi.fn(),
    linkStaffLogin: vi.fn(),
    setStaffActive: vi.fn(),
    setStaffRate: vi.fn(),
    setStaffTelegram: vi.fn(),
    listNonCrewOperators: vi.fn(),
    listAllAccountsById: vi.fn(),
    OperatorAlreadyLinkedError,
    OfficeDisplayNameTakenError,
    TelegramUserIdTakenError,
  };
});

// roleOf is the REAL implementation, not a stub: crewMetadataIsSafe (which is
// also real here) calls it to prove the login being minted reads as crew and NOT
// as an operator. Stubbing it would make that safety check pass vacuously.
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireAdmin,
  roleOf: (meta: unknown) =>
    (meta as { role?: unknown } | null)?.role === 'admin' ? 'admin' : 'operator',
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));
vi.mock('@/lib/auth/adminUsers', () => ({ listNonCrewOperators, listAllAccountsById }));
vi.mock('@/lib/crewMembers', () => ({
  listAllStaff,
  listLinkedAuthUserIds,
  linkOfficeStaff,
  createFieldCrewMember,
  linkStaffLogin,
  setStaffActive,
  setStaffRate,
  setStaffTelegram,
  OperatorAlreadyLinkedError,
  OfficeDisplayNameTakenError,
  TelegramUserIdTakenError,
}));

import { GET, PATCH, POST } from './route';

const OP_ANN = { id: 'op-ann', name: 'Ann', email: 'ann@x.com', role: 'operator' as const, createdAt: null, lastSignInAt: null };
const OP_KELLY = { id: 'op-kelly', name: 'Kelly', email: 'kelly@x.com', role: 'operator' as const, createdAt: null, lastSignInAt: null };

const OFFICE = { id: 'crew-office', displayName: 'Kelly', active: true, authUserId: 'op-kelly', baseRateCents: 2500, telegramUserId: null, isOffice: true };
const FIELD = { id: 'crew-1', displayName: 'SonSon', active: true, authUserId: 'crew-auth-1', baseRateCents: 1600, telegramUserId: '111', isOffice: false };

const body = (method: 'POST' | 'PATCH', b: unknown) =>
  new NextRequest('http://localhost/api/admin/staff', {
    method,
    body: JSON.stringify(b),
    headers: { 'Content-Type': 'application/json' },
  });
const post = (b: unknown) => body('POST', b);
const patch = (b: unknown) => body('PATCH', b);

let updateUserById: ReturnType<typeof vi.fn>;
let createUser: ReturnType<typeof vi.fn>;
let deleteUser: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  updateUserById = vi.fn(async () => ({ error: null }));
  createUser = vi.fn(async () => ({ data: { user: { id: 'new-auth' } }, error: null }));
  deleteUser = vi.fn(async () => ({ error: null }));
  sbRef.current = { auth: { admin: { updateUserById, createUser, deleteUser } } };

  requireAdmin.mockResolvedValue({ operator: { id: 'admin-1' } });
  listAllStaff.mockResolvedValue([OFFICE, FIELD]);
  listLinkedAuthUserIds.mockResolvedValue(new Set<string>());
  listNonCrewOperators.mockResolvedValue([OP_ANN, OP_KELLY]);
  listAllAccountsById.mockResolvedValue(
    new Map([
      ['op-kelly', { ...OP_KELLY, isCrew: false }],
      ['crew-auth-1', { id: 'crew-auth-1', name: 'SonSon', email: 'sonson@x.com', role: 'operator', createdAt: null, lastSignInAt: null, isCrew: true }],
    ]),
  );
  linkOfficeStaff.mockResolvedValue({ ...OFFICE, id: 'crew-new', displayName: 'Ann', authUserId: 'op-ann' });
  createFieldCrewMember.mockResolvedValue({ ...FIELD, id: 'crew-new-field', displayName: 'Little James', authUserId: null, telegramUserId: null });
  linkStaffLogin.mockResolvedValue({ ...FIELD, id: 'crew-new-field', displayName: 'Little James', authUserId: 'new-auth', telegramUserId: null });
  setStaffActive.mockResolvedValue({ ...OFFICE, active: false });
  setStaffRate.mockResolvedValue({ ...OFFICE, baseRateCents: 3000 });
  setStaffTelegram.mockResolvedValue({ ...OFFICE, telegramUserId: '987654321' });
});

describe('GET /api/admin/staff', () => {
  it('blocks a non-admin caller and never queries', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(listAllStaff).not.toHaveBeenCalled();
  });

  it('503s when the service client is not configured', async () => {
    sbRef.current = null;
    expect((await GET()).status).toBe(503);
  });

  it('returns BOTH populations in one list, each with its type and login email', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      staff: Array<{ id: string; isOffice: boolean; email: string | null; hasLogin: boolean; loginMissing: boolean }>;
      eligibleOperators: Array<{ id: string }>;
    };
    expect(b.staff.map((s) => [s.id, s.isOffice, s.email])).toEqual([
      ['crew-office', true, 'kelly@x.com'],
      ['crew-1', false, 'sonson@x.com'],
    ]);
    expect(b.staff.every((s) => s.hasLogin && !s.loginMissing)).toBe(true);
  });

  it('excludes already-linked operators from the picker', async () => {
    listLinkedAuthUserIds.mockResolvedValue(new Set(['op-kelly']));
    const res = await GET();
    const b = (await res.json()) as { eligibleOperators: Array<{ id: string }> };
    expect(b.eligibleOperators.map((o) => o.id)).toEqual(['op-ann']);
  });

  it('flags a row whose login was deleted, and a row that never had one', async () => {
    listAllStaff.mockResolvedValue([
      { ...OFFICE, id: 'ghost', authUserId: 'op-deleted' },
      { ...FIELD, id: 'nologin', authUserId: null },
    ]);
    const res = await GET();
    const b = (await res.json()) as { staff: Array<{ id: string; loginMissing: boolean; hasLogin: boolean }> };
    expect(b.staff.find((s) => s.id === 'ghost')?.loginMissing).toBe(true);
    expect(b.staff.find((s) => s.id === 'nologin')?.hasLogin).toBe(false);
    expect(b.staff.find((s) => s.id === 'nologin')?.loginMissing).toBe(false);
  });

  it('500s without leaking when a lib call throws', async () => {
    listAllStaff.mockRejectedValueOnce(new Error('db down'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('Failed to load staff');
  });
});

describe('POST /api/admin/staff — office', () => {
  it('blocks a non-admin caller and never writes', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: '22.50' }));
    expect(res.status).toBe(403);
    expect(linkOfficeStaff).not.toHaveBeenCalled();
  });

  it('links an operator with the rate parsed to integer cents', async () => {
    const res = await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: '22.50' }));
    expect(res.status).toBe(201);
    expect(linkOfficeStaff).toHaveBeenCalledWith({ authUserId: 'op-ann', displayName: 'Ann', baseRateCents: 2250 });
    // An office setup never mints a login; the operator already has one.
    expect(createUser).not.toHaveBeenCalled();
  });

  it('400s an authUserId that is not a (non-crew) operator account', async () => {
    const res = await POST(post({ type: 'office', authUserId: 'crew-auth-1', hourlyRate: '20' }));
    expect(res.status).toBe(400);
    expect(linkOfficeStaff).not.toHaveBeenCalled();
  });

  it('409s an operator already set up, before writing', async () => {
    listLinkedAuthUserIds.mockResolvedValue(new Set(['op-ann']));
    expect((await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: '20' }))).status).toBe(409);
    expect(linkOfficeStaff).not.toHaveBeenCalled();
  });

  it('maps a lost-race link collision and a name collision to 409', async () => {
    linkOfficeStaff.mockRejectedValueOnce(new OperatorAlreadyLinkedError());
    expect((await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: '20' }))).status).toBe(409);
    linkOfficeStaff.mockRejectedValueOnce(new OfficeDisplayNameTakenError('Ann'));
    expect((await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: '20' }))).status).toBe(409);
  });
});

describe('POST /api/admin/staff — field', () => {
  it('creates the pay row, mints a CREW login and attaches it', async () => {
    const res = await POST(
      post({ type: 'field', displayName: 'Little James', email: 'lj@x.com', password: 'password123', hourlyRate: '17' }),
    );
    expect(res.status).toBe(201);
    expect(createFieldCrewMember).toHaveBeenCalledWith({ displayName: 'Little James', baseRateCents: 1700 });
    // The login must carry the crew marker, which is what confines it.
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'lj@x.com', app_metadata: expect.objectContaining({ role: 'crew' }) }),
    );
    expect(linkStaffLogin).toHaveBeenCalledWith('crew-new-field', 'new-auth');
  });

  it('400s a bad email or a short password, before creating anything', async () => {
    expect((await POST(post({ type: 'field', displayName: 'X', email: 'nope', password: 'password123', hourlyRate: '17' }))).status).toBe(400);
    expect((await POST(post({ type: 'field', displayName: 'X', email: 'x@y.com', password: 'short', hourlyRate: '17' }))).status).toBe(400);
    expect(createFieldCrewMember).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('400s a missing name', async () => {
    const res = await POST(post({ type: 'field', email: 'x@y.com', password: 'password123', hourlyRate: '17' }));
    expect(res.status).toBe(400);
    expect(createFieldCrewMember).not.toHaveBeenCalled();
  });

  it('rolls the orphan login back when the attach loses its compare-and-swap', async () => {
    linkStaffLogin.mockResolvedValueOnce(null);
    const res = await POST(
      post({ type: 'field', displayName: 'Little James', email: 'lj@x.com', password: 'password123', hourlyRate: '17' }),
    );
    expect(res.status).toBe(409);
    expect(deleteUser).toHaveBeenCalledWith('new-auth');
  });

  it('keeps the pay row and says so when the login cannot be created', async () => {
    createUser.mockResolvedValueOnce({ data: null, error: { message: 'email already registered' } });
    const res = await POST(
      post({ type: 'field', displayName: 'Little James', email: 'lj@x.com', password: 'password123', hourlyRate: '17' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('was added');
  });
});

describe('POST /api/admin/staff — shared validation', () => {
  it('400s an unknown type and a bad rate, without writing', async () => {
    expect((await POST(post({ type: 'nonsense', hourlyRate: '20' }))).status).toBe(400);
    expect((await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: 'abc' }))).status).toBe(400);
    expect((await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: '-5' }))).status).toBe(400);
    expect(linkOfficeStaff).not.toHaveBeenCalled();
    expect(createFieldCrewMember).not.toHaveBeenCalled();
  });

  it('503s when the service client is not configured', async () => {
    sbRef.current = null;
    expect((await POST(post({ type: 'office', authUserId: 'op-ann', hourlyRate: '20' }))).status).toBe(503);
  });
});

describe('PATCH /api/admin/staff', () => {
  it('blocks a non-admin caller and never writes', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    expect((await PATCH(patch({ crewMemberId: 'crew-office', active: false }))).status).toBe(403);
    expect(setStaffActive).not.toHaveBeenCalled();
  });

  it('toggles active, edits the rate, and links Telegram — one field at a time', async () => {
    expect((await PATCH(patch({ crewMemberId: 'crew-office', active: false }))).status).toBe(200);
    expect(setStaffActive).toHaveBeenCalledWith('crew-office', false);

    expect((await PATCH(patch({ crewMemberId: 'crew-office', hourlyRate: '30' }))).status).toBe(200);
    expect(setStaffRate).toHaveBeenCalledWith('crew-office', 3000);

    expect((await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: '987654321' }))).status).toBe(200);
    expect(setStaffTelegram).toHaveBeenCalledWith('crew-office', '987654321');
  });

  it('works the same on a FIELD row — that is the whole point of one door', async () => {
    setStaffRate.mockResolvedValueOnce({ ...FIELD, baseRateCents: 1800 });
    const res = await PATCH(patch({ crewMemberId: 'crew-1', hourlyRate: '18' }));
    expect(res.status).toBe(200);
    expect(setStaffRate).toHaveBeenCalledWith('crew-1', 1800);
  });

  it('treats telegramUserId null as UNLINK, and refuses an @handle', async () => {
    setStaffTelegram.mockResolvedValueOnce({ ...OFFICE, telegramUserId: null });
    expect((await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: null }))).status).toBe(200);
    expect(setStaffTelegram).toHaveBeenCalledWith('crew-office', null);

    expect((await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: '@kelly' }))).status).toBe(400);
  });

  it('maps a Telegram collision to 409', async () => {
    setStaffTelegram.mockRejectedValueOnce(new TelegramUserIdTakenError('111'));
    const res = await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: '111' }));
    expect(res.status).toBe(409);
  });

  it('404s when no staff row matched', async () => {
    setStaffActive.mockResolvedValueOnce(null);
    expect((await PATCH(patch({ crewMemberId: 'nobody', active: false }))).status).toBe(404);
  });

  it('400s a missing id, and a body with none of the four fields', async () => {
    expect((await PATCH(patch({ active: false }))).status).toBe(400);
    expect((await PATCH(patch({ crewMemberId: 'crew-office' }))).status).toBe(400);
    expect(setStaffActive).not.toHaveBeenCalled();
  });

  it('400s a JSON primitive body rather than reaching the `in` operator on it', async () => {
    for (const raw of ['42', 'true', '"x"']) {
      const req = new NextRequest('http://localhost/api/admin/staff', {
        method: 'PATCH',
        body: raw,
        headers: { 'Content-Type': 'application/json' },
      });
      expect((await PATCH(req)).status).toBe(400);
    }
  });
});

describe('PATCH /api/admin/staff — password reset', () => {
  it('resets the password of the login attached to that staff row', async () => {
    const res = await PATCH(patch({ crewMemberId: 'crew-office', password: 'newpassword1' }));
    expect(res.status).toBe(200);
    // Resolved from the ROW's auth_user_id, never from the request body.
    expect(updateUserById).toHaveBeenCalledWith('op-kelly', { password: 'newpassword1' });
  });

  it('resets a FIELD crew password too — previously impossible anywhere in the app', async () => {
    const res = await PATCH(patch({ crewMemberId: 'crew-1', password: 'newpassword1' }));
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith('crew-auth-1', { password: 'newpassword1' });
  });

  it('IGNORES an authUserId supplied in the body — the row decides whose password changes', async () => {
    await PATCH(patch({ crewMemberId: 'crew-office', password: 'newpassword1', authUserId: 'some-admin' }));
    expect(updateUserById).toHaveBeenCalledWith('op-kelly', { password: 'newpassword1' });
    expect(updateUserById).not.toHaveBeenCalledWith('some-admin', expect.anything());
  });

  it('400s a short password without calling auth', async () => {
    expect((await PATCH(patch({ crewMemberId: 'crew-office', password: 'short' }))).status).toBe(400);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('404s an unknown staff id and 409s a member with no login', async () => {
    expect((await PATCH(patch({ crewMemberId: 'nobody', password: 'newpassword1' }))).status).toBe(404);
    listAllStaff.mockResolvedValueOnce([{ ...OFFICE, authUserId: null }]);
    expect((await PATCH(patch({ crewMemberId: 'crew-office', password: 'newpassword1' }))).status).toBe(409);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('500s without leaking when the auth update fails', async () => {
    updateUserById.mockResolvedValueOnce({ error: { message: 'gotrue exploded' } });
    const res = await PATCH(patch({ crewMemberId: 'crew-office', password: 'newpassword1' }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('Failed to reset the password');
  });
});
