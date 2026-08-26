// Tests for /api/ops/schedule (P4P Phase 3 scheduling). Rows 356 + 300: the
// route's status mapping is itself a guard — a refused crew id (office staff,
// inactive, unknown) must surface as a 4xx with the reason, never a generic
// 500, and never reach the write. Auth gate + data layer mocked, sibling
// convention of api/jobs/[id]/route.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { assignMock, unassignMock, getScheduleMock, listUnscheduledMock, requireOperatorMock } = vi.hoisted(() => ({
  assignMock: vi.fn(),
  unassignMock: vi.fn(),
  getScheduleMock: vi.fn(),
  listUnscheduledMock: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/scheduling', async (importOriginal) => {
  // The REAL AssignmentRefusedError class rides through so the route's
  // instanceof check is tested against the same identity prod uses — a
  // hand-rolled stand-in class would vacuously pass or fail it.
  const real = await importOriginal<typeof import('@/lib/scheduling')>();
  return {
    AssignmentRefusedError: real.AssignmentRefusedError,
    isCalendarDate: real.isCalendarDate,
    assignCrewToJob: assignMock,
    unassignCrewFromJob: unassignMock,
    getSchedule: getScheduleMock,
    listUnscheduledJobs: listUnscheduledMock,
  };
});

import { POST, DELETE } from './route';
import { AssignmentRefusedError } from '@/lib/scheduling';

const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const post = (body: unknown) =>
  ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  assignMock.mockResolvedValue({ id: 'a1', jobId: 'j1', crewMemberId: 'c1', assignedDate: '2026-08-27' });
  unassignMock.mockResolvedValue(true);
});

const BODY = { jobId: 'j1', crewMemberId: 'c1', date: '2026-08-27' };

describe('POST /api/ops/schedule', () => {
  it('401s when the operator gate denies, before any assign', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(post(BODY));
    expect(res.status).toBe(401);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('400s on a missing field or malformed date', async () => {
    expect((await POST(post({ jobId: 'j1', date: '2026-08-27' }))).status).toBe(400);
    expect((await POST(post({ ...BODY, date: '08/27/2026' }))).status).toBe(400);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('row 356: a refused crew id maps to 422 with the reason verbatim', async () => {
    assignMock.mockRejectedValueOnce(new AssignmentRefusedError('Office staff cannot be assigned to field jobs.'));
    const res = await POST(post(BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Office staff cannot be assigned to field jobs.');
  });

  it('any other failure stays a 500', async () => {
    assignMock.mockRejectedValueOnce(new Error('db died'));
    const res = await POST(post(BODY));
    expect(res.status).toBe(500);
  });

  it('returns the assignment when authorized and valid', async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).assignment).toMatchObject({ id: 'a1' });
  });
});

describe('DELETE /api/ops/schedule', () => {
  it('401s when the gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await DELETE(post(BODY));
    expect(res.status).toBe(401);
    expect(unassignMock).not.toHaveBeenCalled();
  });

  it('reports whether a row was removed', async () => {
    const res = await DELETE(post(BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(true);
  });
});
