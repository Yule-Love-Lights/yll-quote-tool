// Contract: /api/admin/bot-users is admin-only and validates input before the
// data layer touches Supabase (ledger #168). requireAdmin + the botUsers helpers
// are mocked; this covers the gate, validation, and delegation.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdmin, listBotUsers, upsertBotUser } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listBotUsers: vi.fn(),
  upsertBotUser: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/integrations/botUsers', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/botUsers')>()),
  listBotUsers,
  upsertBotUser,
}));

import { GET, POST } from './route';

const adminAuth = { operator: { id: 'admin1', email: 'a@x.com', role: 'admin' } };
const forbidden = { response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
const makeReq = (body: unknown): NextRequest => ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(adminAuth);
  listBotUsers.mockResolvedValue([]);
  upsertBotUser.mockImplementation(async (i: { telegramUserId: string; role: string; displayName?: string | null }) => ({
    telegramUserId: i.telegramUserId,
    displayName: i.displayName ?? null,
    role: i.role,
    addedBy: 'a@x.com',
    createdAt: 't',
    updatedAt: 't',
  }));
});

describe('GET /api/admin/bot-users', () => {
  it('403s for a non-admin and never reads the roster', async () => {
    requireAdmin.mockResolvedValueOnce(forbidden);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(listBotUsers).not.toHaveBeenCalled();
  });

  it('lists the roster for an admin', async () => {
    listBotUsers.mockResolvedValue([{ telegramUserId: '111', role: 'crew' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).users).toHaveLength(1);
  });
});

describe('POST /api/admin/bot-users', () => {
  it('403s for a non-admin and never writes', async () => {
    requireAdmin.mockResolvedValueOnce(forbidden);
    const res = await POST(makeReq({ telegramUserId: '111', role: 'crew' }));
    expect(res.status).toBe(403);
    expect(upsertBotUser).not.toHaveBeenCalled();
  });

  it('rejects a literal null body with a clean 400, not a 500', async () => {
    const res = await POST(makeReq(null));
    expect(res.status).toBe(400);
    expect(upsertBotUser).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric Telegram id', async () => {
    const res = await POST(makeReq({ telegramUserId: '@mike', role: 'crew' }));
    expect(res.status).toBe(400);
    expect(upsertBotUser).not.toHaveBeenCalled();
  });

  it('rejects an unknown role', async () => {
    const res = await POST(makeReq({ telegramUserId: '111', role: 'superuser' }));
    expect(res.status).toBe(400);
    expect(upsertBotUser).not.toHaveBeenCalled();
  });

  it('rejects an over-long name', async () => {
    const res = await POST(makeReq({ telegramUserId: '111', role: 'crew', displayName: 'x'.repeat(81) }));
    expect(res.status).toBe(400);
  });

  it('adds a valid entry and records who added it', async () => {
    const res = await POST(makeReq({ telegramUserId: '8547103546', displayName: 'Naldo', role: 'admin' }));
    expect(res.status).toBe(201);
    expect(upsertBotUser).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: '8547103546', role: 'admin', addedBy: 'a@x.com' }),
    );
  });
});
