// Office web clock API — the office lane (source 'office'), its auth gate, and
// the idempotent actions. Auth resolver + shift/break IO are mocked; the route's
// own action dispatch, source tagging, and 409 state-guards run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getOfficeClockCaller, clockIn, clockOut, getOpenShift, startBreak, endBreak, getOpenBreak } =
  vi.hoisted(() => ({
    getOfficeClockCaller: vi.fn(),
    clockIn: vi.fn(),
    clockOut: vi.fn(),
    getOpenShift: vi.fn(),
    startBreak: vi.fn(),
    endBreak: vi.fn(),
    getOpenBreak: vi.fn(),
  }));

vi.mock('@/lib/auth/officeClock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/officeClock')>();
  return { ...actual, getOfficeClockCaller };
});
vi.mock('@/lib/shifts', () => ({ clockIn, clockOut, getOpenShift }));
vi.mock('@/lib/shiftBreaks', () => ({ startBreak, endBreak, getOpenBreak }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));

import { GET, POST } from './route';

const CALLER = { crewMemberId: 'crew-1', authUserId: 'auth-1', displayName: 'Kelly' };
const OPEN_SHIFT = { id: 'shift-1', crewMemberId: 'crew-1', clockInAt: '2026-08-21T13:00:00Z' };
const OPEN_BREAK = { id: 'break-1', shiftId: 'shift-1' };

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getOfficeClockCaller.mockResolvedValue({ ok: true, caller: CALLER });
  getOpenShift.mockResolvedValue(null);
  getOpenBreak.mockResolvedValue(null);
  clockIn.mockResolvedValue(OPEN_SHIFT);
  clockOut.mockResolvedValue({ ...OPEN_SHIFT, clockOutAt: '2026-08-21T21:00:00Z' });
  startBreak.mockResolvedValue(OPEN_BREAK);
  endBreak.mockResolvedValue({ ...OPEN_BREAK, endedAt: '2026-08-21T13:30:00Z' });
});

describe('office clock — auth gate', () => {
  it('401s an unauthenticated caller and touches no shift', async () => {
    getOfficeClockCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    const res = await POST(makeReq({ action: 'in' }));
    expect(res.status).toBe(401);
    expect(clockIn).not.toHaveBeenCalled();
  });

  it('403s a CREW login — crew have their own clock, and their punch must not read as office', async () => {
    getOfficeClockCaller.mockResolvedValue({ ok: false, reason: 'is_crew' });
    const res = await POST(makeReq({ action: 'in' }));
    expect(res.status).toBe(403);
    expect(clockIn).not.toHaveBeenCalled();
  });

  it('403s an operator login not linked to a staff row', async () => {
    getOfficeClockCaller.mockResolvedValue({ ok: false, reason: 'unlinked' });
    const res = await GET();
    expect(res.status).toBe(403);
  });
});

describe('office clock — actions', () => {
  it("clocks in with source 'office', from the session id not the body", async () => {
    // A hostile body naming someone else's crew id must be ignored.
    const res = await POST(makeReq({ action: 'in', crewMemberId: 'someone-else' }));
    expect(res.status).toBe(200);
    expect(clockIn).toHaveBeenCalledWith('crew-1', 'office');
    expect(clockIn).not.toHaveBeenCalledWith('someone-else', expect.anything());
  });

  it('is idempotent on a double clock-in (clockIn returns the open shift)', async () => {
    clockIn.mockResolvedValue(OPEN_SHIFT); // already open
    const res = await POST(makeReq({ action: 'in' }));
    expect(res.status).toBe(200);
    expect(clockIn).toHaveBeenCalledTimes(1);
  });

  it('409s a clock-out when not clocked in, and does not call clockOut', async () => {
    getOpenShift.mockResolvedValue(null);
    const res = await POST(makeReq({ action: 'out' }));
    expect(res.status).toBe(409);
    expect(clockOut).not.toHaveBeenCalled();
  });

  it("clocks out the open shift with source 'office'", async () => {
    getOpenShift.mockResolvedValue(OPEN_SHIFT);
    const res = await POST(makeReq({ action: 'out' }));
    expect(res.status).toBe(200);
    expect(clockOut).toHaveBeenCalledWith('shift-1', 'crew-1', 'office');
  });

  it('409s break-start when not clocked in', async () => {
    getOpenShift.mockResolvedValue(null);
    const res = await POST(makeReq({ action: 'break-start' }));
    expect(res.status).toBe(409);
    expect(startBreak).not.toHaveBeenCalled();
  });

  it('starts a break on the open shift', async () => {
    getOpenShift.mockResolvedValue(OPEN_SHIFT);
    getOpenBreak.mockResolvedValue(null);
    const res = await POST(makeReq({ action: 'break-start' }));
    expect(res.status).toBe(200);
    expect(startBreak).toHaveBeenCalledWith('shift-1', 'crew-1', 'office');
  });

  it('is idempotent on a double break-start (a break is already open)', async () => {
    getOpenShift.mockResolvedValue(OPEN_SHIFT);
    getOpenBreak.mockResolvedValue(OPEN_BREAK);
    const res = await POST(makeReq({ action: 'break-start' }));
    expect(res.status).toBe(200);
    expect(startBreak).not.toHaveBeenCalled();
  });

  it('409s break-end when not on a break', async () => {
    getOpenShift.mockResolvedValue(OPEN_SHIFT);
    getOpenBreak.mockResolvedValue(null);
    const res = await POST(makeReq({ action: 'break-end' }));
    expect(res.status).toBe(409);
    expect(endBreak).not.toHaveBeenCalled();
  });

  it('ends the open break', async () => {
    getOpenShift.mockResolvedValue(OPEN_SHIFT);
    getOpenBreak.mockResolvedValue(OPEN_BREAK);
    const res = await POST(makeReq({ action: 'break-end' }));
    expect(res.status).toBe(200);
    expect(endBreak).toHaveBeenCalledWith('break-1', 'crew-1', 'office');
  });

  it('400s an unknown action', async () => {
    const res = await POST(makeReq({ action: 'teleport' }));
    expect(res.status).toBe(400);
    expect(clockIn).not.toHaveBeenCalled();
  });
});

describe('office clock — GET state', () => {
  it('reports clocked-out when there is no open shift', async () => {
    getOpenShift.mockResolvedValue(null);
    const res = await GET();
    const body = await res.json();
    expect(body.clockedIn).toBe(false);
    expect(body.onBreak).toBe(false);
    expect(body.staff.name).toBe('Kelly');
  });

  it('reports clocked-in and on-break state', async () => {
    getOpenShift.mockResolvedValue(OPEN_SHIFT);
    getOpenBreak.mockResolvedValue(OPEN_BREAK);
    const res = await GET();
    const body = await res.json();
    expect(body.clockedIn).toBe(true);
    expect(body.onBreak).toBe(true);
  });
});
