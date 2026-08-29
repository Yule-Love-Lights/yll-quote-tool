// The advertising caller resolver — the route-layer half of the population
// lock (#1043 built the perimeter half). An advertising session resolves to
// its worker row; every other kind of session resolves to a refusal with a
// named reason, so routes can pick the right status code.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createRouteSupabase, getAdvertisingWorkerByAuthUserId } = vi.hoisted(() => ({
  createRouteSupabase: vi.fn(),
  getAdvertisingWorkerByAuthUserId: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, createRouteSupabase };
});
vi.mock('@/lib/advertising/workers', () => ({ getAdvertisingWorkerByAuthUserId }));

import { getAdvertisingCaller } from './advertisingAuth';

const WORKER = {
  id: 'worker-1',
  displayName: 'Joe Signs',
  authUserId: 'auth-ad-1',
  active: true,
  isTest: false,
  createdAt: '2026-08-28T12:00:00.000Z',
  updatedAt: '2026-08-28T12:00:00.000Z',
};

function sessionWith(appMetadata: Record<string, unknown> | null) {
  createRouteSupabase.mockResolvedValue({
    auth: {
      getUser: async () =>
        appMetadata === null
          ? { data: { user: null }, error: null }
          : { data: { user: { id: 'auth-ad-1', app_metadata: appMetadata } }, error: null },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingWorkerByAuthUserId.mockResolvedValue(WORKER);
});

describe('getAdvertisingCaller', () => {
  it('resolves an advertising session to its worker row', async () => {
    sessionWith({ role: 'advertising', name: 'Joe' });
    const result = await getAdvertisingCaller();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.worker.id).toBe('worker-1');
  });

  it('refuses an unauthenticated request as unauthenticated', async () => {
    sessionWith(null);
    const result = await getAdvertisingCaller();
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('refuses an operator session — office staff do not use the advertising surface', async () => {
    sessionWith({ role: 'operator' });
    const result = await getAdvertisingCaller();
    expect(result).toEqual({ ok: false, reason: 'not_advertising' });
    expect(getAdvertisingWorkerByAuthUserId).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN session the same way — review happens on the admin surface', async () => {
    sessionWith({ role: 'admin' });
    const result = await getAdvertisingCaller();
    expect(result).toEqual({ ok: false, reason: 'not_advertising' });
  });

  it('refuses a crew session', async () => {
    sessionWith({ role: 'crew' });
    const result = await getAdvertisingCaller();
    expect(result).toEqual({ ok: false, reason: 'not_advertising' });
  });

  it('refuses an advertising login with no worker row (not set up)', async () => {
    sessionWith({ role: 'advertising' });
    getAdvertisingWorkerByAuthUserId.mockResolvedValue(null);
    const result = await getAdvertisingCaller();
    expect(result).toEqual({ ok: false, reason: 'no_worker_row' });
  });

  it('refuses a deactivated worker', async () => {
    sessionWith({ role: 'advertising' });
    getAdvertisingWorkerByAuthUserId.mockResolvedValue({ ...WORKER, active: false });
    const result = await getAdvertisingCaller();
    expect(result).toEqual({ ok: false, reason: 'inactive' });
  });

  it('fails closed when auth is unconfigured', async () => {
    createRouteSupabase.mockResolvedValue(null);
    const result = await getAdvertisingCaller();
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });
});
