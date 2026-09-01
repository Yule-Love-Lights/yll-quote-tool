// Tests for POST /api/admin/shifts/manual — the manual payroll entry route.
// Lib functions are mocked (they carry their own suite in shifts.test.ts,
// including mutation-probed overlap and CAS guards); this file pins the
// route's own promises: the ADMIN gate, body validation, the actor stamp
// passed through, and the refusal-code → status mapping.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

class FakeRefusedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ManualShiftRefusedError';
  }
}

const { requireAdminMock, createMock, updateMock, voidMock, RefusedRef } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  voidMock: vi.fn(),
  RefusedRef: { current: null as unknown },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireAdmin: requireAdminMock,
}));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));
vi.mock('@/lib/shifts', () => {
  class ManualShiftRefusedError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'ManualShiftRefusedError';
    }
  }
  RefusedRef.current = ManualShiftRefusedError;
  return {
    adminCreateShift: createMock,
    adminUpdateShiftTimes: updateMock,
    adminVoidShift: voidMock,
    ManualShiftRefusedError,
  };
});

import { DELETE, POST } from './route';

const ADMIN = { operator: { id: 'u1', email: 'naldo@x.com', role: 'admin', name: 'Naldo' } };
const SHIFT = { id: 's1', crewMemberId: 'c1', clockInAt: 'a', clockOutAt: 'b', manualBy: 'Naldo' };

function makeReq(body?: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as unknown as NextRequest;
}

function refused(code: string) {
  const Ctor = RefusedRef.current as new (code: string, message: string) => Error;
  return new Ctor(code, `refused: ${code}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue(ADMIN);
  createMock.mockResolvedValue(SHIFT);
  updateMock.mockResolvedValue(SHIFT);
  voidMock.mockResolvedValue(undefined);
});

describe('the admin gate', () => {
  it('returns the gate response and never writes when not an admin', async () => {
    requireAdminMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    const res = await POST(makeReq({ crewMemberId: 'c1', clockInAt: 'a', clockOutAt: 'b' }));
    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('400s without both timestamps', async () => {
    const res = await POST(makeReq({ crewMemberId: 'c1', clockInAt: 'a' }));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('400s on a create without crewMemberId', async () => {
    const res = await POST(makeReq({ clockInAt: 'a', clockOutAt: 'b' }));
    expect(res.status).toBe(400);
  });

  it('400s on malformed JSON', async () => {
    const res = await POST(makeReq(undefined));
    expect(res.status).toBe(400);
  });
});

describe('the actor stamp', () => {
  it('passes name plus email to a create (two admins can share a name)', async () => {
    const res = await POST(makeReq({ crewMemberId: 'c1', clockInAt: 'a', clockOutAt: 'b' }));
    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledWith({
      crewMemberId: 'c1',
      clockInAt: 'a',
      clockOutAt: 'b',
      actor: 'Naldo (naldo@x.com)',
    });
  });

  it('an edit may pass clockOutAt null (keep the shift open); a create may not', async () => {
    await POST(makeReq({ shiftId: 's1', clockInAt: 'a', clockOutAt: null }));
    expect(updateMock).toHaveBeenCalledWith({
      shiftId: 's1',
      clockInAt: 'a',
      clockOutAt: null,
      actor: 'Naldo (naldo@x.com)',
    });
    const res = await POST(makeReq({ crewMemberId: 'c1', clockInAt: 'a', clockOutAt: null }));
    expect(res.status).toBe(400);
  });

  it('falls back to the email when the name is missing', async () => {
    requireAdminMock.mockResolvedValueOnce({
      operator: { id: 'u1', email: 'naldo@x.com', role: 'admin', name: null },
    });
    await POST(makeReq({ shiftId: 's1', clockInAt: 'a', clockOutAt: 'b' }));
    expect(updateMock).toHaveBeenCalledWith({
      shiftId: 's1',
      clockInAt: 'a',
      clockOutAt: 'b',
      actor: 'naldo@x.com',
    });
  });
});

describe('refusal mapping', () => {
  it.each([
    ['invalid-times', 400],
    ['not-found', 404],
    ['overlap', 409],
    ['edit-race', 409],
  ])('%s → %i', async (code, status) => {
    updateMock.mockRejectedValueOnce(refused(code));
    const res = await POST(makeReq({ shiftId: 's1', clockInAt: 'a', clockOutAt: 'b' }));
    expect(res.status).toBe(status);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe(code);
  });

  it('an untyped failure is a 500 with no internals leaked', async () => {
    createMock.mockRejectedValueOnce(new Error('supabase exploded'));
    const res = await POST(makeReq({ crewMemberId: 'c1', clockInAt: 'a', clockOutAt: 'b' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toContain('exploded');
  });
});

// Sanity: the local fake refusal class mirrors the real one's shape.
void FakeRefusedError;

// Voiding a manual entry DELETES a payroll row, so the route's own promises
// matter as much as the lib's: admins only, an id required, and every typed
// refusal answered honestly rather than as a generic failure (row 458).
describe('DELETE, voiding a manual entry', () => {
  it('refuses a non-admin and never calls the lib', async () => {
    requireAdminMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    const res = await DELETE(makeReq({ shiftId: 's1' }));
    expect(res.status).toBe(403);
    expect(voidMock).not.toHaveBeenCalled();
  });

  it('passes the shift id and the admin actor stamp through', async () => {
    const res = await DELETE(makeReq({ shiftId: 's1' }));
    expect(res.status).toBe(200);
    expect(voidMock).toHaveBeenCalledWith({
      shiftId: 's1',
      actor: 'Naldo (naldo@x.com)',
    });
  });

  it('rejects a body with no shift id', async () => {
    const res = await DELETE(makeReq({}));
    expect(res.status).toBe(400);
    expect(voidMock).not.toHaveBeenCalled();
  });

  it('answers a crew-clocked row with 409 not-manual', async () => {
    voidMock.mockRejectedValueOnce(refused('not-manual'));
    const res = await DELETE(makeReq({ shiftId: 's1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not-manual');
  });

  it('answers a shift with breaks or job time with 409 has-children', async () => {
    voidMock.mockRejectedValueOnce(refused('has-children'));
    const res = await DELETE(makeReq({ shiftId: 's1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('has-children');
  });

  it('answers an unknown id with 404', async () => {
    voidMock.mockRejectedValueOnce(refused('not-found'));
    const res = await DELETE(makeReq({ shiftId: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('answers a lost race with 409 edit-race', async () => {
    voidMock.mockRejectedValueOnce(refused('edit-race'));
    const res = await DELETE(makeReq({ shiftId: 's1' }));
    expect(res.status).toBe(409);
  });
});
