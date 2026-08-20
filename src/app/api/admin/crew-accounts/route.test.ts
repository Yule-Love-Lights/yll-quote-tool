// Contract: PATCH /api/admin/crew-accounts is admin-only and is the ONLY door in
// the app that can write crew_members.telegram_user_id — the identity the
// Telegram time clock resolves a punch through. Before row 313 nothing could
// write it, so every crew member's "in" was unrecognised.
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAdmin, maybeSingle, updateCrewMember, TelegramUserIdTakenError } = vi.hoisted(() => {
  // Declared here because vi.mock factories are hoisted above module scope, and
  // the 409 mapping is an `instanceof` check — a plain object would make the
  // test pass for the wrong reason.
  class TelegramUserIdTakenError extends Error {
    constructor(id: string) {
      super(`Telegram account ${id} is already linked to another crew member`);
      this.name = 'TelegramUserIdTakenError';
    }
  }
  return {
    requireAdmin: vi.fn(),
    maybeSingle: vi.fn(),
    updateCrewMember: vi.fn(),
    TelegramUserIdTakenError,
  };
});

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));
vi.mock('@/lib/auth/crewAccounts', () => ({
  crewAppMetadata: () => ({ role: 'crew' }),
  crewMetadataIsSafe: () => true,
  validateCrewAccount: () => ({ ok: true }),
}));

vi.mock('@/lib/crewMembers', () => ({ TelegramUserIdTakenError, updateCrewMember }));

import { PATCH } from './route';

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
