// Worker earnings view — the money a worker sees. Always scoped to the
// SESSION worker; there is no way to read another worker's numbers here.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAdvertisingCaller, earningsSummary } = vi.hoisted(() => ({
  getAdvertisingCaller: vi.fn(),
  earningsSummary: vi.fn(),
}));

vi.mock('@/lib/auth/advertisingAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/advertisingAuth')>();
  return { ...actual, getAdvertisingCaller };
});
vi.mock('@/lib/advertising/placements', () => ({ earningsSummary }));

import { GET } from './route';

const CALLER = {
  ok: true,
  worker: { id: 'worker-1', displayName: 'Joe Signs', authUserId: 'auth-1', active: true, isTest: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCaller.mockResolvedValue(CALLER);
  earningsSummary.mockResolvedValue([
    {
      workerId: 'worker-1',
      total: { pendingEstimatedCents: 500, acceptedEarnedCents: 1250 },
      byDay: [],
      byWeek: [],
    },
  ]);
});

describe('GET /api/advertising/earnings', () => {
  it('returns the session worker\'s summary, scoped at the query', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(earningsSummary).toHaveBeenCalledWith({ workerId: 'worker-1' });
    const body = await res.json();
    expect(body.summary.total.acceptedEarnedCents).toBe(1250);
  });

  it('returns an all-zero summary when the worker has no placements yet', async () => {
    earningsSummary.mockResolvedValue([]);
    const res = await GET();
    const body = await res.json();
    expect(body.summary.total).toEqual({ pendingEstimatedCents: 0, acceptedEarnedCents: 0 });
  });

  it('401s logged-out and 403s non-advertising sessions', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    expect((await GET()).status).toBe(401);
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'not_advertising' });
    expect((await GET()).status).toBe(403);
  });
});
