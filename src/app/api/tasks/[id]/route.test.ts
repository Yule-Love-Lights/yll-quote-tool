// Tests for PATCH /api/tasks/[id] (calls merge plan S1 — Office Tasks).
// Auth resolver + the officeTasks data layer are mocked; this route's own
// gating, idempotency-key requirement, reason-rule validation, and
// error-code-to-HTTP mapping run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, getOperatorMock, updateOfficeTaskStatus } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'a@b.com', role: 'operator', name: null })),
  updateOfficeTaskStatus: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock, getOperator: getOperatorMock }));
vi.mock('@/lib/officeTasks', () => ({ updateOfficeTaskStatus }));

import { PATCH } from './route';

const TASK_ID = '22222222-2222-2222-2222-222222222222';
const VALID_KEY = '11111111-1111-1111-1111-111111111111';

function makeReq(body: unknown, headers: Record<string, string> = { 'x-idempotency-key': VALID_KEY }): NextRequest {
  const h = new Headers(headers);
  return { headers: h, json: async () => body } as unknown as NextRequest;
}

function call(body: unknown, headers?: Record<string, string>, id = TASK_ID) {
  return PATCH(makeReq(body, headers), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'a@b.com', role: 'operator', name: null });
  updateOfficeTaskStatus.mockResolvedValue({ ok: true, taskId: TASK_ID });
});

describe('PATCH /api/tasks/[id] — auth gate', () => {
  it('401s when requireOperator denies', async () => {
    const { NextResponse } = await import('next/server');
    requireOperatorMock.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(401);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('403s when no operator resolves', async () => {
    getOperatorMock.mockResolvedValue(null);
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/tasks/[id] — idempotency key and id validation', () => {
  it('400s with no idempotency key', async () => {
    const res = await call({ status: 'completed' }, {});
    expect(res.status).toBe(400);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('404s a non-uuid id — never reaches the data layer', async () => {
    const res = await call({ status: 'completed' }, undefined, 'not-a-uuid');
    expect(res.status).toBe(404);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tasks/[id] — reason rules', () => {
  it('400s an invalid status value', async () => {
    const res = await call({ status: 'archived' });
    expect(res.status).toBe(400);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('400s blocking without a reason', async () => {
    const res = await call({ status: 'blocked' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('TASK_REASON_REQUIRED');
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('400s blocking with a whitespace-only reason', async () => {
    const res = await call({ status: 'blocked', reason: '   ' });
    expect(res.status).toBe(400);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('400s dismissing without a reason', async () => {
    const res = await call({ status: 'dismissed' });
    expect(res.status).toBe(400);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('400s completing WITH a reason (completed tasks do not accept one)', async () => {
    const res = await call({ status: 'completed', reason: 'because' });
    expect(res.status).toBe(400);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('400s a reason over 500 characters', async () => {
    const res = await call({ status: 'blocked', reason: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(updateOfficeTaskStatus).not.toHaveBeenCalled();
  });

  it('completes with no reason — passes null through', async () => {
    await call({ status: 'completed' });
    expect(updateOfficeTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', reason: null, actorId: 'op-1' }),
    );
  });

  it('blocks with a trimmed reason', async () => {
    await call({ status: 'blocked', reason: '  waiting on the vendor  ' });
    expect(updateOfficeTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blocked', reason: 'waiting on the vendor' }),
    );
  });
});

describe('PATCH /api/tasks/[id] — error-code mapping', () => {
  it('200s on success', async () => {
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe(TASK_ID);
    expect(body.status).toBe('completed');
  });

  it('409s idempotency_conflict', async () => {
    updateOfficeTaskStatus.mockResolvedValue({ ok: false, reason: 'idempotency_conflict' });
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(409);
  });

  // Ownership violation (not the creator/assignee) and "id doesn't exist"
  // BOTH surface as 404 — a non-owner cannot probe existence via a 403 vs
  // 404 status difference.
  it('404s not_found (covers both "not yours" and "doesn\'t exist")', async () => {
    updateOfficeTaskStatus.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(404);
  });

  it('409s state_conflict (the task changed before this action landed)', async () => {
    updateOfficeTaskStatus.mockResolvedValue({ ok: false, reason: 'state_conflict' });
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('TASK_STATE_CONFLICT');
  });

  it('503s not_ready', async () => {
    updateOfficeTaskStatus.mockResolvedValue({ ok: false, reason: 'not_ready' });
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(503);
  });

  it('503s unavailable', async () => {
    updateOfficeTaskStatus.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(503);
  });

  it('500s a generic failure', async () => {
    updateOfficeTaskStatus.mockResolvedValue({ ok: false, reason: 'failed' });
    const res = await call({ status: 'completed' });
    expect(res.status).toBe(500);
  });
});
