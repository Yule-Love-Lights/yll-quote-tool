// Resubmit — the one state transition a WORKER may perform, and only on their
// own rejected placement. Ownership is checked against the session, never the
// body.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAdvertisingCaller, getPlacement, resubmitPlacement } = vi.hoisted(() => ({
  getAdvertisingCaller: vi.fn(),
  getPlacement: vi.fn(),
  resubmitPlacement: vi.fn(),
}));

vi.mock('@/lib/auth/advertisingAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/advertisingAuth')>();
  return { ...actual, getAdvertisingCaller };
});
vi.mock('@/lib/advertising/placements', () => ({ getPlacement, resubmitPlacement }));

import { POST } from './route';

const CALLER = {
  ok: true,
  worker: { id: 'worker-1', displayName: 'Joe Signs', authUserId: 'auth-1', active: true, isTest: false },
};

const REJECTED = {
  id: 'placement-9',
  workerId: 'worker-1',
  status: 'rejected',
  rejectionReason: 'blurry',
};

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCaller.mockResolvedValue(CALLER);
  getPlacement.mockResolvedValue(REJECTED);
  resubmitPlacement.mockResolvedValue({ ...REJECTED, status: 'resubmitted' });
});

describe('POST /api/advertising/placements/[id]/resubmit', () => {
  it('resubmits the caller\'s own rejected placement', async () => {
    const res = await POST({} as never, makeParams('placement-9'));
    expect(res.status).toBe(200);
    expect(resubmitPlacement).toHaveBeenCalledWith('placement-9');
  });

  it('404s a placement belonging to ANOTHER worker — existence is not leaked', async () => {
    getPlacement.mockResolvedValue({ ...REJECTED, workerId: 'worker-2' });
    const res = await POST({} as never, makeParams('placement-9'));
    expect(res.status).toBe(404);
    expect(resubmitPlacement).not.toHaveBeenCalled();
  });

  it('404s a missing placement', async () => {
    getPlacement.mockResolvedValue(null);
    const res = await POST({} as never, makeParams('nope'));
    expect(res.status).toBe(404);
    expect(resubmitPlacement).not.toHaveBeenCalled();
  });

  it('409s a placement that is not rejected (surfacing the data layer refusal)', async () => {
    getPlacement.mockResolvedValue({ ...REJECTED, status: 'accepted' });
    resubmitPlacement.mockRejectedValue(new Error("placement placement-9 is 'accepted', only rejected placements can be resubmitted"));
    const res = await POST({} as never, makeParams('placement-9'));
    expect(res.status).toBe(409);
  });

  it('401s logged-out and 403s non-advertising sessions', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    expect((await POST({} as never, makeParams('placement-9'))).status).toBe(401);
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'not_advertising' });
    expect((await POST({} as never, makeParams('placement-9'))).status).toBe(403);
    expect(resubmitPlacement).not.toHaveBeenCalled();
  });
});
