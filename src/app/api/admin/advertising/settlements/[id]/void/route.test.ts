// The door that REVERSES money. Its own duties, separate from the data
// layer's: an admin only, a reason required, the actor taken from the
// session, and the one failure that needs a person named as such instead of
// being folded into "nothing was changed".
//
// Written because the delta-verify on PR #1136 pointed out this route shipped
// with no test at all while its sibling had ten.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireAdmin, voidSettlement } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  voidSettlement: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/payouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/payouts')>();
  return { ...actual, voidSettlement };
});

import { POST } from './route';

const ADMIN = { operator: { id: 'admin-1', email: 'n@x.com', role: 'admin', name: 'Naldo' } };
const ctx = { params: Promise.resolve({ id: 'settlement-1' }) };

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  voidSettlement.mockResolvedValue({
    id: 'settlement-1',
    workerId: 'worker-1',
    totalCents: 250,
    method: 'cash',
    note: null,
    paidAt: '2026-08-30T18:00:00.000Z',
    paidBy: 'admin-1',
    lineCount: 1,
    createdAt: '2026-08-30T18:00:00.000Z',
    voidedAt: '2026-08-31T10:00:00.000Z',
    voidedBy: 'admin-1',
    voidReason: 'recorded against the wrong worker',
  });
});

describe('POST void', () => {
  it('undoes the payment with the ADMIN SESSION as the actor', async () => {
    const res = await POST(req({ reason: 'recorded against the wrong worker' }), ctx);
    expect(res.status).toBe(200);
    // Never an actor from the body: the record must name who really did it.
    expect(voidSettlement).toHaveBeenCalledWith('settlement-1', 'admin-1', 'recorded against the wrong worker');
  });

  it('ignores an actor supplied in the body', async () => {
    await POST(req({ reason: 'mistake', voidedBy: 'someone-else' }), ctx);
    expect(voidSettlement).toHaveBeenCalledWith('settlement-1', 'admin-1', 'mistake');
  });

  it('requires a reason, and a blank one does not count', async () => {
    // An unexplained reversal of pay is worse than none.
    const missing = await POST(req({}), ctx);
    expect(missing.status).toBe(400);
    const blank = await POST(req({ reason: '   ' }), ctx);
    expect(blank.status).toBe(400);
    expect(voidSettlement).not.toHaveBeenCalled();
  });

  it('trims the reason before it is recorded', async () => {
    await POST(req({ reason: '  paid the wrong person  ' }), ctx);
    expect(voidSettlement).toHaveBeenCalledWith('settlement-1', 'admin-1', 'paid the wrong person');
  });

  it('requires an admin', async () => {
    requireAdmin.mockResolvedValue({ response: new Response('no', { status: 403 }) });
    const res = await POST(req({ reason: 'mistake' }), ctx);
    expect(res.status).toBe(403);
    expect(voidSettlement).not.toHaveBeenCalled();
  });

  it('says the payment is gone rather than blaming the server', async () => {
    voidSettlement.mockRejectedValue(new Error('voidSettlement: no settlement found for id settlement-1'));
    const res = await POST(req({ reason: 'mistake' }), ctx);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no longer exists/i);
  });

  // The state a person has to finish by hand: the photos are already
  // released, so the payment counts as nothing while still reading as live.
  // Telling the admin "nothing was changed" there would be false.
  it('names the half-done state instead of claiming nothing changed', async () => {
    voidSettlement.mockRejectedValue(
      new Error(
        'voidSettlement: the photos were released but settlement settlement-1 still reads as live (timeout) — run the undo again to finish it',
      ),
    );
    const res = await POST(req({ reason: 'mistake' }), ctx);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/photos were released/i);
    expect(body.error).toMatch(/undo it again/i);
    expect(body.error).not.toMatch(/nothing was changed/i);
  });

  it('falls back to nothing-was-changed only when nothing was', async () => {
    // The FIRST write failing leaves the payment whole, so this wording is
    // true here and only here.
    voidSettlement.mockRejectedValue(
      new Error('voidSettlement: the photos could not be released (connection reset), nothing was voided'),
    );
    const res = await POST(req({ reason: 'mistake' }), ctx);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/nothing was changed/i);
  });
});
