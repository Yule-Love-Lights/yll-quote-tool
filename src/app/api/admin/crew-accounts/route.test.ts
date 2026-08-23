// Contract: PATCH /api/admin/crew-accounts is admin-only and is the ONLY door in
// the app that can write crew_members.telegram_user_id — the identity the
// Telegram time clock resolves a punch through. Before row 318 nothing could
// write it, so every crew member's "in" was unrecognised.
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAdmin, maybeSingle, order, eq, updateCrewMember, TelegramUserIdTakenError } = vi.hoisted(() => {
  // Declared here because vi.mock factories are hoisted above module scope, and
  // the 409 mapping is an `instanceof` check — a plain object would make the
  // test pass for the wrong reason.
  class TelegramUserIdTakenError extends Error {
    constructor(id: string) {
      super(`Telegram account ${id} is already linked to another crew member`);
      this.name = 'TelegramUserIdTakenError';
    }
  }
  // One shared query-builder stub. GET uses select().eq().order(); the
  // PATCH/POST lookups use select().eq().maybeSingle(). So eq() returns BOTH
  // terminals and each test drives the one it needs.
  const maybeSingle = vi.fn();
  const order = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle, order }));
  return {
    requireAdmin: vi.fn(),
    maybeSingle,
    order,
    eq,
    updateCrewMember: vi.fn(),
    TelegramUserIdTakenError,
  };
});

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: () => ({ select: () => ({ eq }) }),
  }),
}));
vi.mock('@/lib/auth/crewAccounts', () => ({
  crewAppMetadata: () => ({ role: 'crew' }),
  crewMetadataIsSafe: () => true,
  validateCrewAccount: () => ({ ok: true }),
}));

vi.mock('@/lib/crewMembers', () => ({ TelegramUserIdTakenError, updateCrewMember }));

import { GET, PATCH } from './route';

const CREW = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const req = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/crew-accounts', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ operator: { id: 'admin-1' } });
  maybeSingle.mockResolvedValue({
    data: { id: CREW, display_name: 'SonSon', active: true, auth_user_id: null, telegram_user_id: null },
    error: null,
  });
  updateCrewMember.mockResolvedValue({ id: CREW, displayName: 'SonSon', telegramUserId: '123456789' });
  order.mockResolvedValue({ data: [], error: null });
});

describe('PATCH /api/admin/crew-accounts', () => {
  it('blocks a non-admin caller and never writes', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await PATCH(req({ crewMemberId: CREW, telegramUserId: '123456789' }));
    expect(res.status).toBe(403);
    expect(updateCrewMember).not.toHaveBeenCalled();
  });

  it('links a numeric Telegram id', async () => {
    const res = await PATCH(req({ crewMemberId: CREW, telegramUserId: '123456789' }));
    expect(res.status).toBe(200);
    expect(updateCrewMember).toHaveBeenCalledWith(CREW, { telegramUserId: '123456789' });
  });

  it('treats null as UNLINK rather than as a validation error', async () => {
    updateCrewMember.mockResolvedValueOnce({ id: CREW, displayName: 'SonSon', telegramUserId: null });
    const res = await PATCH(req({ crewMemberId: CREW, telegramUserId: null }));
    expect(res.status).toBe(200);
    expect(updateCrewMember).toHaveBeenCalledWith(CREW, { telegramUserId: null });
  });

  it('REFUSES an @handle — Telegram sends a number, so a handle would never match', async () => {
    const res = await PATCH(req({ crewMemberId: CREW, telegramUserId: '@sonson' }));
    expect(res.status).toBe(400);
    expect(updateCrewMember).not.toHaveBeenCalled();
  });

  it('refuses a missing telegramUserId key, which is a caller bug, not an unlink', async () => {
    const res = await PATCH(req({ crewMemberId: CREW }));
    expect(res.status).toBe(400);
    expect(updateCrewMember).not.toHaveBeenCalled();
  });

  it('404s an unknown crew member without writing', async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await PATCH(req({ crewMemberId: CREW, telegramUserId: '123456789' }));
    expect(res.status).toBe(404);
    expect(updateCrewMember).not.toHaveBeenCalled();
  });

  it('maps a duplicate-link collision to 409, not 500', async () => {
    updateCrewMember.mockRejectedValueOnce(new TelegramUserIdTakenError('123456789'));
    const res = await PATCH(req({ crewMemberId: CREW, telegramUserId: '123456789' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('already linked');
  });
});

describe('GET /api/admin/crew-accounts', () => {
  it('EXCLUDES office staff (is_office = false) — they punch the office web clock, not this panel', async () => {
    order.mockResolvedValue({
      data: [
        { id: 'f1', display_name: 'SonSon', active: true, auth_user_id: null, telegram_user_id: null },
        { id: 'f2', display_name: 'Big James', active: true, auth_user_id: null, telegram_user_id: '5' },
      ],
      error: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    // The filter is the whole point of the change: office staff carry an operator
    // login and must never be offered a crew-role login or a Telegram clock here.
    expect(eq).toHaveBeenCalledWith('is_office', false);
    const body = (await res.json()) as { crew: Array<{ displayName: string; hasLogin: boolean }> };
    expect(body.crew.map((c) => c.displayName)).toEqual(['SonSon', 'Big James']);
    expect(body.crew[0].hasLogin).toBe(false);
  });

  it('blocks a non-admin caller and never queries', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(eq).not.toHaveBeenCalled();
  });

  it('500s when the query errors, without leaking the DB message', async () => {
    order.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('Failed to load crew members');
  });
});
