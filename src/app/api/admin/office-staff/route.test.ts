// Contract: /api/admin/office-staff is admin-only and is the app-side replacement
// for hand-written SQL that gives an office person a time-clock identity. It links
// an EXISTING operator login to a crew_members pay row (is_office=true); it never
// creates an auth user or handles a password. The real dollarsToCents is used, so
// the money conversion is exercised end-to-end rather than mocked.
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdmin,
  sbRef,
  listOfficeStaff,
  listLinkedAuthUserIds,
  linkOfficeStaff,
  setOfficeStaffActive,
  setOfficeStaffRate,
  setOfficeStaffTelegram,
  listNonCrewOperators,
  OperatorAlreadyLinkedError,
  OfficeDisplayNameTakenError,
  TelegramUserIdTakenError,
} = vi.hoisted(() => {
  // Real error subclasses so the route's instanceof mapping is tested for the
  // right reason (a plain object would 500 through the wrong branch).
  class OperatorAlreadyLinkedError extends Error {
    constructor() {
      super('That operator is already set up as staff.');
      this.name = 'OperatorAlreadyLinkedError';
    }
  }
  class TelegramUserIdTakenError extends Error {
    constructor(id: string) {
      super(`Telegram account ${id} is already linked to another crew member`);
      this.name = 'TelegramUserIdTakenError';
    }
  }
  class OfficeDisplayNameTakenError extends Error {
    constructor(displayName: string) {
      super(`The name "${displayName}" is already in use by another staff member.`);
      this.name = 'OfficeDisplayNameTakenError';
    }
  }
  return {
    requireAdmin: vi.fn(),
    sbRef: { current: {} as unknown },
    listOfficeStaff: vi.fn(),
    listLinkedAuthUserIds: vi.fn(),
    linkOfficeStaff: vi.fn(),
    setOfficeStaffActive: vi.fn(),
    setOfficeStaffRate: vi.fn(),
    setOfficeStaffTelegram: vi.fn(),
    listNonCrewOperators: vi.fn(),
    OperatorAlreadyLinkedError,
    OfficeDisplayNameTakenError,
    TelegramUserIdTakenError,
  };
});

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));
vi.mock('@/lib/auth/adminUsers', () => ({ listNonCrewOperators }));
vi.mock('@/lib/crewMembers', () => ({
  listOfficeStaff,
  listLinkedAuthUserIds,
  linkOfficeStaff,
  setOfficeStaffActive,
  setOfficeStaffRate,
  setOfficeStaffTelegram,
  TelegramUserIdTakenError,
  OperatorAlreadyLinkedError,
  OfficeDisplayNameTakenError,
}));

import { GET, PATCH, POST } from './route';

const OP_ANN = { id: 'op-ann', name: 'Ann', email: 'ann@x.com', role: 'operator' as const, createdAt: null, lastSignInAt: null };
const OP_KELLY = { id: 'op-kelly', name: 'Kelly', email: 'kelly@x.com', role: 'operator' as const, createdAt: null, lastSignInAt: null };

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/office-staff', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/office-staff', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  sbRef.current = {};
  requireAdmin.mockResolvedValue({ operator: { id: 'admin-1' } });
  listOfficeStaff.mockResolvedValue([]);
  listLinkedAuthUserIds.mockResolvedValue(new Set<string>());
  listNonCrewOperators.mockResolvedValue([OP_ANN, OP_KELLY]);
  linkOfficeStaff.mockResolvedValue({ id: 'crew-new', displayName: 'Ann', active: true, authUserId: 'op-ann', baseRateCents: 2250 });
  setOfficeStaffActive.mockResolvedValue({ id: 'crew-office', displayName: 'Kelly', active: false, authUserId: 'op-kelly', baseRateCents: 2500 });
  setOfficeStaffRate.mockResolvedValue({ id: 'crew-office', displayName: 'Kelly', active: true, authUserId: 'op-kelly', baseRateCents: 3000 });
  setOfficeStaffTelegram.mockResolvedValue({ id: 'crew-office', displayName: 'Kelly', active: true, authUserId: 'op-kelly', baseRateCents: 2500, telegramUserId: '987654321' });
});

describe('GET /api/admin/office-staff', () => {
  it('blocks a non-admin caller and never queries', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(listOfficeStaff).not.toHaveBeenCalled();
  });

  it('503s when the service client is not configured', async () => {
    sbRef.current = null;
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('joins office staff to their operator and excludes already-linked operators from the picker', async () => {
    listOfficeStaff.mockResolvedValue([
      { id: 'crew-office', displayName: 'Kelly', active: true, authUserId: 'op-kelly', baseRateCents: 2500, telegramUserId: null },
    ]);
    listLinkedAuthUserIds.mockResolvedValue(new Set(['op-kelly']));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      officeStaff: Array<{ id: string; operatorEmail: string | null; operatorMissing: boolean; baseRateCents: number }>;
      eligibleOperators: Array<{ id: string }>;
    };
    // Kelly is joined to her operator account, rate visible, operator present…
    expect(body.officeStaff).toEqual([
      {
        id: 'crew-office',
        displayName: 'Kelly',
        active: true,
        authUserId: 'op-kelly',
        baseRateCents: 2500,
        telegramUserId: null,
        operatorEmail: 'kelly@x.com',
        operatorName: 'Kelly',
        operatorMissing: false,
      },
    ]);
    // …and is NOT offered again in the picker; only the unlinked operator is.
    expect(body.eligibleOperators.map((o) => o.id)).toEqual(['op-ann']);
  });

  it('flags an office row whose operator login was deleted (dangling) instead of hiding it', async () => {
    listOfficeStaff.mockResolvedValue([
      { id: 'crew-ghost', displayName: 'Gone', active: true, authUserId: 'op-deleted', baseRateCents: 2000, telegramUserId: null },
    ]);
    listLinkedAuthUserIds.mockResolvedValue(new Set(['op-deleted']));
    // op-deleted is NOT among listNonCrewOperators (deleted from the accounts store).
    const res = await GET();
    const body = (await res.json()) as {
      officeStaff: Array<{ operatorMissing: boolean; operatorEmail: string | null }>;
    };
    expect(body.officeStaff[0].operatorMissing).toBe(true);
    expect(body.officeStaff[0].operatorEmail).toBeNull();
  });

  it('500s (without leaking) when a lib call throws', async () => {
    listOfficeStaff.mockRejectedValueOnce(new Error('db down'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('Failed to load office staff');
  });
});

describe('POST /api/admin/office-staff', () => {
  it('blocks a non-admin caller and never writes', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await POST(post({ authUserId: 'op-ann', hourlyRate: '22.50' }));
    expect(res.status).toBe(403);
    expect(linkOfficeStaff).not.toHaveBeenCalled();
  });

  it('links an operator with the rate parsed to integer cents (money math end-to-end)', async () => {
    const res = await POST(post({ authUserId: 'op-ann', hourlyRate: '22.50' }));
    expect(res.status).toBe(201);
    expect(linkOfficeStaff).toHaveBeenCalledWith({ authUserId: 'op-ann', displayName: 'Ann', baseRateCents: 2250 });
  });

  it('uses a display-name override when supplied (resolves a name collision without SQL)', async () => {
    await POST(post({ authUserId: 'op-ann', hourlyRate: '22', displayName: 'Ann Office' }));
    expect(linkOfficeStaff).toHaveBeenCalledWith({ authUserId: 'op-ann', displayName: 'Ann Office', baseRateCents: 2200 });
  });

  it('400s a missing operator and a bad rate, without writing', async () => {
    expect((await POST(post({ hourlyRate: '22.50' }))).status).toBe(400);
    expect((await POST(post({ authUserId: 'op-ann', hourlyRate: 'abc' }))).status).toBe(400);
    expect((await POST(post({ authUserId: 'op-ann', hourlyRate: '-5' }))).status).toBe(400);
    expect(linkOfficeStaff).not.toHaveBeenCalled();
  });

  it('400s an authUserId that is not a (non-crew) operator account', async () => {
    const res = await POST(post({ authUserId: 'crew-1', hourlyRate: '20' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not an operator');
    expect(linkOfficeStaff).not.toHaveBeenCalled();
  });

  it('409s an operator who is already linked, before writing', async () => {
    listLinkedAuthUserIds.mockResolvedValue(new Set(['op-ann']));
    const res = await POST(post({ authUserId: 'op-ann', hourlyRate: '20' }));
    expect(res.status).toBe(409);
    expect(linkOfficeStaff).not.toHaveBeenCalled();
  });

  it('maps a lost-race link collision (OperatorAlreadyLinkedError) to 409', async () => {
    linkOfficeStaff.mockRejectedValueOnce(new OperatorAlreadyLinkedError());
    const res = await POST(post({ authUserId: 'op-ann', hourlyRate: '20' }));
    expect(res.status).toBe(409);
  });

  it('maps a display-name collision (OfficeDisplayNameTakenError) to 409', async () => {
    linkOfficeStaff.mockRejectedValueOnce(new OfficeDisplayNameTakenError('Ann'));
    const res = await POST(post({ authUserId: 'op-ann', hourlyRate: '20' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('already in use');
  });

  it('503s when the service client is not configured', async () => {
    sbRef.current = null;
    const res = await POST(post({ authUserId: 'op-ann', hourlyRate: '20' }));
    expect(res.status).toBe(503);
  });
});

describe('PATCH /api/admin/office-staff', () => {
  it('blocks a non-admin caller and never writes', async () => {
    requireAdmin.mockResolvedValueOnce({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await PATCH(patch({ crewMemberId: 'crew-office', active: false }));
    expect(res.status).toBe(403);
    expect(setOfficeStaffActive).not.toHaveBeenCalled();
  });

  it('toggles an office staffer active state', async () => {
    const res = await PATCH(patch({ crewMemberId: 'crew-office', active: false }));
    expect(res.status).toBe(200);
    expect(setOfficeStaffActive).toHaveBeenCalledWith('crew-office', false);
  });

  it('edits an office staffer rate, parsing dollars to integer cents', async () => {
    const res = await PATCH(patch({ crewMemberId: 'crew-office', hourlyRate: '30' }));
    expect(res.status).toBe(200);
    expect(setOfficeStaffRate).toHaveBeenCalledWith('crew-office', 3000);
    expect(setOfficeStaffActive).not.toHaveBeenCalled();
  });

  it('400s a bad rate on edit, without writing', async () => {
    const res = await PATCH(patch({ crewMemberId: 'crew-office', hourlyRate: 'abc' }));
    expect(res.status).toBe(400);
    expect(setOfficeStaffRate).not.toHaveBeenCalled();
  });

  it('404s a rate edit when no office row matched (unknown or field-crew id)', async () => {
    setOfficeStaffRate.mockResolvedValueOnce(null);
    const res = await PATCH(patch({ crewMemberId: 'crew-field', hourlyRate: '20' }));
    expect(res.status).toBe(404);
  });

  it('links an office staffer Telegram — office staff text the bot too (Naldo 2026-08-24)', async () => {
    const res = await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: '987654321' }));
    expect(res.status).toBe(200);
    expect(setOfficeStaffTelegram).toHaveBeenCalledWith('crew-office', '987654321');
    expect(setOfficeStaffActive).not.toHaveBeenCalled();
    expect(setOfficeStaffRate).not.toHaveBeenCalled();
  });

  it('treats null as UNLINK, not a validation error', async () => {
    setOfficeStaffTelegram.mockResolvedValueOnce({ id: 'crew-office', displayName: 'Kelly', active: true, authUserId: 'op-kelly', baseRateCents: 2500, telegramUserId: null });
    const res = await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: null }));
    expect(res.status).toBe(200);
    expect(setOfficeStaffTelegram).toHaveBeenCalledWith('crew-office', null);
  });

  it('REFUSES an @handle and a leading zero, without writing', async () => {
    expect((await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: '@kelly' }))).status).toBe(400);
    expect((await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: '0123' }))).status).toBe(400);
    expect(setOfficeStaffTelegram).not.toHaveBeenCalled();
  });

  it('maps a Telegram collision to 409, not 500', async () => {
    setOfficeStaffTelegram.mockRejectedValueOnce(new TelegramUserIdTakenError('111'));
    const res = await PATCH(patch({ crewMemberId: 'crew-office', telegramUserId: '111' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('already linked');
  });

  it('404s a Telegram link when no office row matched (unknown or field-crew id)', async () => {
    setOfficeStaffTelegram.mockResolvedValueOnce(null);
    const res = await PATCH(patch({ crewMemberId: 'crew-field', telegramUserId: '987654321' }));
    expect(res.status).toBe(404);
  });

  it('400s a missing id, or a body with neither active nor hourlyRate, without writing', async () => {
    expect((await PATCH(patch({ active: false }))).status).toBe(400);
    expect((await PATCH(patch({ crewMemberId: 'crew-office' }))).status).toBe(400);
    expect((await PATCH(patch({ crewMemberId: 'crew-office', active: 'no' }))).status).toBe(400);
    expect(setOfficeStaffActive).not.toHaveBeenCalled();
    expect(setOfficeStaffRate).not.toHaveBeenCalled();
  });

  it('404s when no office row matched — an unknown id OR a field-crew id (by-construction guard)', async () => {
    setOfficeStaffActive.mockResolvedValueOnce(null);
    const res = await PATCH(patch({ crewMemberId: 'crew-field', active: false }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('not an office staff member');
  });
});
