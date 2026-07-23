// Contract: /api/admin/bot-users/[id] is admin-only; PATCH preserves the field
// it doesn't touch, and both handlers 404 a missing / malformed id (#168).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdmin, getBotUser, upsertBotUser, deleteBotUser } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getBotUser: vi.fn(),
  upsertBotUser: vi.fn(),
  deleteBotUser: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/integrations/botUsers', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/botUsers')>()),
  getBotUser,
  upsertBotUser,
  deleteBotUser,
}));

import { PATCH, DELETE } from './route';

const adminAuth = { operator: { id: 'admin1', email: 'a@x.com', role: 'admin' } };
const forbidden = { response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
const makeReq = (body: unknown): NextRequest => ({ json: async () => body }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const EXISTING = { telegramUserId: '111', displayName: 'Mike', role: 'crew', addedBy: null, createdAt: 't', updatedAt: 't' };

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(adminAuth);
  getBotUser.mockResolvedValue(EXISTING);
  upsertBotUser.mockImplementation(async (i: Record<string, unknown>) => ({ ...EXISTING, ...i }));
  deleteBotUser.mockResolvedValue(true);
});

describe('PATCH /api/admin/bot-users/[id]', () => {
  it('403s for a non-admin', async () => {
    requireAdmin.mockResolvedValueOnce(forbidden);
    const res = await PATCH(makeReq({ role: 'staff' }), ctx('111'));
    expect(res.status).toBe(403);
    expect(upsertBotUser).not.toHaveBeenCalled();
  });

  it('404s a non-numeric id', async () => {
    const res = await PATCH(makeReq({ role: 'staff' }), ctx('@mike'));
    expect(res.status).toBe(404);
  });

  it('404s an id absent from the roster', async () => {
    getBotUser.mockResolvedValue(null);
    const res = await PATCH(makeReq({ role: 'staff' }), ctx('999'));
    expect(res.status).toBe(404);
  });

  it('400s a literal null body instead of throwing a 500', async () => {
    const res = await PATCH(makeReq(null), ctx('111'));
    expect(res.status).toBe(400);
    expect(upsertBotUser).not.toHaveBeenCalled();
  });

  it('400s an empty patch', async () => {
    const res = await PATCH(makeReq({}), ctx('111'));
    expect(res.status).toBe(400);
  });

  it('400s an unknown role', async () => {
    const res = await PATCH(makeReq({ role: 'boss' }), ctx('111'));
    expect(res.status).toBe(400);
  });

  it('a role-only change PRESERVES the existing name', async () => {
    const res = await PATCH(makeReq({ role: 'staff' }), ctx('111'));
    expect(res.status).toBe(200);
    expect(upsertBotUser).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: '111', role: 'staff', displayName: 'Mike' }),
    );
  });

  it('a name-only change PRESERVES the existing role', async () => {
    const res = await PATCH(makeReq({ displayName: 'Michael' }), ctx('111'));
    expect(res.status).toBe(200);
    expect(upsertBotUser).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: '111', role: 'crew', displayName: 'Michael' }),
    );
  });
});

describe('DELETE /api/admin/bot-users/[id]', () => {
  it('403s for a non-admin', async () => {
    requireAdmin.mockResolvedValueOnce(forbidden);
    const res = await DELETE(makeReq(null), ctx('111'));
    expect(res.status).toBe(403);
    expect(deleteBotUser).not.toHaveBeenCalled();
  });

  it('removes an existing entry', async () => {
    const res = await DELETE(makeReq(null), ctx('111'));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
  });

  it('404s when the entry was not present', async () => {
    deleteBotUser.mockResolvedValue(false);
    const res = await DELETE(makeReq(null), ctx('111'));
    expect(res.status).toBe(404);
  });
});
