// Tests for GET /api/tasks/count — the nav badge's counts. The auth resolver
// and the officeTasks data layer are mocked; this route's own gating, its
// shape, and its degraded-state behaviour run for real.
//
// The behaviour that matters most here is the DEGRADED one: this endpoint
// feeds shared chrome rendered on every operator page, so a task-schema
// problem must never put an error on an unrelated screen. It answers zeroes
// and says so in the body instead.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { requireOperatorMock, countActiveOfficeTasks } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  countActiveOfficeTasks: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/officeTasks', () => ({ countActiveOfficeTasks }));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  countActiveOfficeTasks.mockResolvedValue({ ok: true, counts: { open: 7, overdue: 2 } });
});

describe('GET /api/tasks/count', () => {
  it('401s when requireOperator denies, and never reads the counts', async () => {
    requireOperatorMock.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(countActiveOfficeTasks).not.toHaveBeenCalled();
  });

  it('returns the open and overdue counts', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ open: 7, overdue: 2, available: true });
  });

  it('never caches — the badge must not go stale behind a CDN or bfcache', async () => {
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 200 with zeroes when the task schema is not ready, so unrelated pages show no error', async () => {
    countActiveOfficeTasks.mockResolvedValue({ ok: false, reason: 'not_ready' });
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ open: 0, overdue: 0, available: false });
  });

  it('answers 200 with zeroes when task access is unavailable, for the same reason', async () => {
    countActiveOfficeTasks.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ open: 0, overdue: 0, available: false });
  });

  it('does not require an operator id — the counts are not per-person', async () => {
    // Everything is shared: these counts are the same for every operator, so
    // this route deliberately does NOT call getOperator the way GET /api/tasks
    // does (that one needs an actor id to label "You"). A signed-in caller is
    // enough.
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
