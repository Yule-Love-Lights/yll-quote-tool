// Minting a My Day entry link (row 466). Admin only, and it refuses to mint for
// anyone the office cannot revoke by unlinking their Telegram account.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { requireAdmin, getCrewMember, stampCrewLinkJti, logCrewAccess } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getCrewMember: vi.fn(),
  stampCrewLinkJti: vi.fn(),
  logCrewAccess: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/crewMembers', () => ({ getCrewMember, stampCrewLinkJti }));
vi.mock('@/lib/crew/accessEvents', () => ({ logCrewAccess }));
vi.mock('@/lib/integrations/telegramNotify', () => ({ appBaseUrl: () => 'https://quote.example.com' }));

import { POST } from './route';
import { verifyCrewToken } from '@/lib/auth/crewLink';

const member = (over: Record<string, unknown> = {}) => ({
  id: 'crew-1',
  displayName: 'Field Crew One',
  active: true,
  telegramUserId: '900001',
  ...over,
});
const call = (id = 'crew-1') => POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id }) });

let prevSecret: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  prevSecret = process.env.CREW_LINK_SECRET;
  process.env.CREW_LINK_SECRET = 'test-secret-value-for-crew-links';
  requireAdmin.mockResolvedValue({ operator: { id: 'admin-1', role: 'admin' } });
  getCrewMember.mockResolvedValue(member());
  stampCrewLinkJti.mockResolvedValue(undefined);
  logCrewAccess.mockResolvedValue(undefined);
});

afterEach(() => {
  if (prevSecret === undefined) delete process.env.CREW_LINK_SECRET;
  else process.env.CREW_LINK_SECRET = prevSecret;
});

describe('POST /api/admin/crew/[id]/link', () => {
  it('mints a link that verifies back to that crew member', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    const token = new URL(body.url).searchParams.get('t');
    expect(verifyCrewToken('link', token, Date.now())).toMatchObject({ ok: true, crewMemberId: 'crew-1' });
    expect(body.expiresInMinutes).toBe(15);
  });

  it('mints a LINK, never a session token', async () => {
    const token = new URL((await (await call()).json()).url).searchParams.get('t');
    expect(verifyCrewToken('session', token, Date.now())).toEqual({ ok: false, reason: 'wrong_purpose' });
  });

  it('refuses a non-admin caller before reading any crew row', async () => {
    requireAdmin.mockResolvedValue({ response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) });
    const res = await call();
    expect(res.status).toBe(403);
    expect(getCrewMember).not.toHaveBeenCalled();
  });

  it('404s an unknown crew member', async () => {
    getCrewMember.mockResolvedValue(null);
    expect((await call('ghost')).status).toBe(404);
  });

  it('refuses an inactive crew member', async () => {
    getCrewMember.mockResolvedValue(member({ active: false }));
    expect((await call()).status).toBe(409);
  });

  // The link IS the identity. Minting one for an unlinked person would create a
  // door that unlinking cannot close.
  it('refuses a crew member with no Telegram account linked', async () => {
    getCrewMember.mockResolvedValue(member({ telegramUserId: null }));
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Telegram/);
  });

  it('503s when the door secret is not configured, rather than minting something unverifiable', async () => {
    delete process.env.CREW_LINK_SECRET;
    const res = await call();
    expect(res.status).toBe(503);
  });

  // Single use: the id in the link must be the id stamped on the crew row, or
  // the entry route would consume something that was never issued.
  it('stamps the SAME single-use id it puts in the link', async () => {
    const token = new URL((await (await call()).json()).url).searchParams.get('t');
    const verified = verifyCrewToken('link', token, Date.now());
    expect(verified.ok && verified.jti).toBeTruthy();
    expect(stampCrewLinkJti).toHaveBeenCalledWith('crew-1', verified.ok ? verified.jti : null);
  });

  it('binds the link to the crew member Telegram account', async () => {
    const token = new URL((await (await call()).json()).url).searchParams.get('t');
    expect(verifyCrewToken('link', token, Date.now())).toMatchObject({ binding: '900001' });
  });

  it('records who minted it', async () => {
    await call();
    expect(logCrewAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'link_minted', crewMemberId: 'crew-1', actor: 'admin-1' }),
    );
  });

  it('stamps nothing when the door secret is missing', async () => {
    delete process.env.CREW_LINK_SECRET;
    await call();
    expect(stampCrewLinkJti).not.toHaveBeenCalled();
  });
});
