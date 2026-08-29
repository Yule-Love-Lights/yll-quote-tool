// Worker earnings view — the money a worker sees. Always scoped to the
// SESSION worker; there is no way to read another worker's numbers here.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAdvertisingCaller, earningsSummary, listPlacements, listRateChangeEvents } = vi.hoisted(() => ({
  getAdvertisingCaller: vi.fn(),
  earningsSummary: vi.fn(),
  listPlacements: vi.fn(),
  listRateChangeEvents: vi.fn(),
}));

vi.mock('@/lib/auth/advertisingAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/advertisingAuth')>();
  return { ...actual, getAdvertisingCaller };
});
vi.mock('@/lib/advertising/placements', () => ({ earningsSummary, listPlacements }));
vi.mock('@/lib/advertising/rateChangeNote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/rateChangeNote')>();
  // hasPendingRateChange stays REAL (it is the pure logic under test through
  // the route); only the db read is mocked.
  return { ...actual, listRateChangeEvents };
});

import { GET } from './route';

const CALLER = {
  ok: true,
  worker: { id: 'worker-1', displayName: 'Joe Signs', authUserId: 'auth-1', active: true, isTest: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCaller.mockResolvedValue(CALLER);
  listPlacements.mockResolvedValue([]);
  listRateChangeEvents.mockResolvedValue([]);
  earningsSummary.mockResolvedValue([
    {
      workerId: 'worker-1',
      total: { pendingEstimatedCents: 500, acceptedEarnedCents: 1250 },
      byDay: [],
      byWeek: [],
    },
  ]);
});

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  campaignId: 'c1',
  workerId: 'worker-1',
  kind: 'yard_sign',
  status: 'pending',
  capturedAt: '2026-08-25T10:00:00Z',
  createdAt: '2026-08-25T10:00:00Z',
  isTest: false,
  ...over,
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

  it('flags a rate change that happened AFTER a pending row was captured', async () => {
    listPlacements.mockResolvedValue([pendingRow()]);
    listRateChangeEvents.mockResolvedValue([{ campaignId: 'c1', createdAt: '2026-08-27T10:00:00Z' }]);
    const body = await (await GET()).json();
    expect(body.rateChangedSincePending).toBe(true);
    expect(listPlacements).toHaveBeenCalledWith({ workerId: 'worker-1' });
  });

  it('does not flag when there are no pending rows, and never queries events', async () => {
    listPlacements.mockResolvedValue([pendingRow({ status: 'accepted' })]);
    const body = await (await GET()).json();
    expect(body.rateChangedSincePending).toBe(false);
    expect(listRateChangeEvents).not.toHaveBeenCalled();
  });

  it('does not flag a change on a campaign the pending rows do not belong to', async () => {
    listPlacements.mockResolvedValue([pendingRow()]);
    listRateChangeEvents.mockResolvedValue([{ campaignId: 'other', createdAt: '2026-08-27T10:00:00Z' }]);
    const body = await (await GET()).json();
    expect(body.rateChangedSincePending).toBe(false);
  });

  it('401s logged-out and 403s non-advertising sessions', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    expect((await GET()).status).toBe(401);
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'not_advertising' });
    expect((await GET()).status).toBe(403);
  });
});
