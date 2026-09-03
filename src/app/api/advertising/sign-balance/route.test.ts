// The crew's own sign balance. The admin issuances route is requireAdmin and
// returns EVERY worker; this is the worker-facing half, and its whole job is
// to be scoped to the session worker and to nobody else.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAdvertisingCaller, getWorkerSignBalance } = vi.hoisted(() => ({
  getAdvertisingCaller: vi.fn(),
  getWorkerSignBalance: vi.fn(),
}));

vi.mock('@/lib/auth/advertisingAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/advertisingAuth')>();
  return { ...actual, getAdvertisingCaller };
});
vi.mock('@/lib/advertising/signIssuances', () => ({ getWorkerSignBalance }));

import { GET } from './route';

const CALLER = {
  ok: true as const,
  worker: { id: 'worker-1', displayName: 'Joe', authUserId: 'auth-1', active: true, isTest: false, createdAt: 'x', updatedAt: 'x' },
};

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCaller.mockResolvedValue(CALLER);
  getWorkerSignBalance.mockResolvedValue({ workerId: 'worker-1', issuedTotal: 50, signsUsed: 38, remaining: 12 });
});

describe('GET /api/advertising/sign-balance', () => {
  it('returns the SESSION worker\u2019s balance, and reads it for that id only', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toEqual({ workerId: 'worker-1', issuedTotal: 50, signsUsed: 38, remaining: 12 });
    expect(getWorkerSignBalance).toHaveBeenCalledWith('worker-1');
  });

  it('refuses a logged-out or non-advertising caller and reads nothing', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    expect((await GET()).status).toBe(401);
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'not_advertising' });
    expect((await GET()).status).toBe(403);
    expect(getWorkerSignBalance).not.toHaveBeenCalled();
  });

  it('a failed read says so instead of rendering a confident zero', async () => {
    getWorkerSignBalance.mockRejectedValue(new Error('db down'));
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.balance).toBeUndefined();
  });
});
