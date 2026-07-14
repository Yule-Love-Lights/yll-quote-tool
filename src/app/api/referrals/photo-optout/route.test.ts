// Tests for POST /api/referrals/photo-optout (staff photo opt-out toggle,
// ledger #41 PR 2). setReferralPhotoOptout is mocked — its own DB logic is
// covered in src/lib/referrals.test.ts. This route's job is the wiring: the
// operator gate, the body validation, and passing the flag through unchanged.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, isSupabaseServiceConfiguredMock, setReferralPhotoOptoutMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  isSupabaseServiceConfiguredMock: vi.fn(() => true),
  setReferralPhotoOptoutMock: vi.fn(async () => true),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: isSupabaseServiceConfiguredMock }));
vi.mock('@/lib/referrals', () => ({ setReferralPhotoOptout: setReferralPhotoOptoutMock }));

import { POST } from './route';

const CUSTOMER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  isSupabaseServiceConfiguredMock.mockReturnValue(true);
  setReferralPhotoOptoutMock.mockResolvedValue(true);
});

describe('POST /api/referrals/photo-optout', () => {
  it('is operator-gated — denied when requireOperator refuses', async () => {
    const denial = new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    requireOperatorMock.mockResolvedValueOnce(denial);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, optout: true }));
    expect(res.status).toBe(401);
    expect(setReferralPhotoOptoutMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed customerId', async () => {
    const res = await POST(makeReq({ customerId: 'not-a-uuid', optout: true }));
    expect(res.status).toBe(400);
    expect(setReferralPhotoOptoutMock).not.toHaveBeenCalled();
  });

  it('400s when optout is not a boolean', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, optout: 'yes' }));
    expect(res.status).toBe(400);
    expect(setReferralPhotoOptoutMock).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const req = { json: async () => { throw new Error('bad json'); } } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('passes optout=true straight through to setReferralPhotoOptout', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, optout: true }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(setReferralPhotoOptoutMock).toHaveBeenCalledWith(CUSTOMER_ID, true);
    expect(json).toEqual({ ok: true, optout: true });
  });

  it('passes optout=false straight through (no flipped polarity)', async () => {
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, optout: false }));
    const json = await res.json();
    expect(setReferralPhotoOptoutMock).toHaveBeenCalledWith(CUSTOMER_ID, false);
    expect(json).toEqual({ ok: true, optout: false });
  });

  it('500s when the DB write fails', async () => {
    setReferralPhotoOptoutMock.mockResolvedValueOnce(false);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, optout: true }));
    expect(res.status).toBe(500);
  });

  it('503s when Supabase service role is not configured', async () => {
    isSupabaseServiceConfiguredMock.mockReturnValueOnce(false);
    const res = await POST(makeReq({ customerId: CUSTOMER_ID, optout: true }));
    expect(res.status).toBe(503);
    expect(setReferralPhotoOptoutMock).not.toHaveBeenCalled();
  });
});
