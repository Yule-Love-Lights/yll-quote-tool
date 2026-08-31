// Sign one crew member out of My Day everywhere. Admin only, and the whole
// point is that it works when the Telegram account is UNCHANGED (delta-verify
// on PR #1094: the earlier telegram-id binding did not).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { requireAdmin, getCrewMember, rotateCrewSessionEpoch } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getCrewMember: vi.fn(),
  rotateCrewSessionEpoch: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/crewMembers', () => ({ getCrewMember, rotateCrewSessionEpoch }));

import { POST } from './route';

const call = (id = 'crew-1') =>
  POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ operator: { id: 'admin-1', role: 'admin' } });
  getCrewMember.mockResolvedValue({ id: 'crew-1', displayName: 'Field Crew One', telegramUserId: '900001', active: true });
  rotateCrewSessionEpoch.mockResolvedValue('epoch-2');
});

describe('POST /api/admin/crew/[id]/revoke', () => {
  it('rotates that crew member epoch and says who was signed out', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(rotateCrewSessionEpoch).toHaveBeenCalledWith('crew-1');
    expect((await res.json()).crewMember).toEqual({ id: 'crew-1', displayName: 'Field Crew One' });
  });

  it('refuses a non-admin caller before rotating anything', async () => {
    requireAdmin.mockResolvedValue({ response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(rotateCrewSessionEpoch).not.toHaveBeenCalled();
  });

  it('404s an unknown crew member without rotating anything', async () => {
    getCrewMember.mockResolvedValue(null);
    expect((await call('ghost')).status).toBe(404);
    expect(rotateCrewSessionEpoch).not.toHaveBeenCalled();
  });

  // The lever must not depend on the Telegram account changing: that was the
  // exact hole the delta-verify found.
  it('rotates even when the Telegram account is untouched', async () => {
    await call();
    expect(rotateCrewSessionEpoch).toHaveBeenCalledTimes(1);
  });
});
