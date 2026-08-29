// Tests for GET/POST /api/tasks (calls merge plan S1 — Office Tasks).
// Auth resolver + the officeTasks data layer are mocked; this route's own
// gating, idempotency-key requirement, body validation, view-param
// dispatch, and error-code-to-HTTP mapping run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperatorMock, getOperatorMock, listOfficeTasks, createManualOfficeTask } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'a@b.com', role: 'operator', name: null })),
  listOfficeTasks: vi.fn(),
  createManualOfficeTask: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock, getOperator: getOperatorMock }));
vi.mock('@/lib/officeTasks', () => ({ listOfficeTasks, createManualOfficeTask }));

import { GET, POST } from './route';

const TASK = {
  id: 't-1',
  sourceSystem: 'manual' as const,
  title: 'Call the vendor',
  detail: null,
  status: 'open' as const,
  dueAt: '2026-08-29T12:00:00.000Z',
  createdAt: '2026-08-28T12:00:00.000Z',
  updatedAt: '2026-08-28T12:00:00.000Z',
  blockedReason: null,
  dismissalReason: null,
  completedAt: null,
  dismissedAt: null,
  createdByLabel: 'You',
  assignedToLabel: 'Jason',
};

function makeGetReq(query = ''): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(query) },
  } as unknown as NextRequest;
}

function makePostReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const h = new Headers(headers);
  return {
    headers: h,
    json: async () => body,
  } as unknown as NextRequest;
}

const VALID_KEY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'a@b.com', role: 'operator', name: null });
  listOfficeTasks.mockResolvedValue({ ok: true, tasks: [TASK] });
  createManualOfficeTask.mockResolvedValue({ ok: true, taskId: 'new-task' });
});

describe('GET /api/tasks — auth gate', () => {
  it('401s when requireOperator denies, and never reads the list', async () => {
    requireOperatorMock.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
    expect(listOfficeTasks).not.toHaveBeenCalled();
  });

  it('403s when the gate is dormant and no operator resolves (Office Tasks needs a real actor id)', async () => {
    getOperatorMock.mockResolvedValue(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(403);
    expect(listOfficeTasks).not.toHaveBeenCalled();
  });
});

describe('GET /api/tasks — view dispatch and shape', () => {
  it('defaults to the active view (open + blocked)', async () => {
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    expect(listOfficeTasks).toHaveBeenCalledWith('op-1', 'active');
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe('t-1');
    // The list-fix from the plan: sourceSystem rides through so a later
    // slice's call_commitment/quote_tool rows need no route change.
    expect(body.tasks[0].sourceSystem).toBe('manual');
  });

  it('passes the assignee label through, which is what the /tasks owner filter reads', async () => {
    const res = await GET(makeGetReq());
    const body = await res.json();
    expect(body.tasks[0].assignedToLabel).toBe('Jason');
    expect(body.tasks[0].createdByLabel).toBe('You');
  });

  it('reads the history view on ?status=history — finished work stays reachable', async () => {
    const res = await GET(makeGetReq('status=history'));
    expect(res.status).toBe(200);
    expect(listOfficeTasks).toHaveBeenCalledWith('op-1', 'history');
  });

  it('any other ?status value falls back to active (not a silent 500)', async () => {
    await GET(makeGetReq('status=bogus'));
    expect(listOfficeTasks).toHaveBeenCalledWith('op-1', 'active');
  });

  it('503s with TASKS_NOT_READY when the migration is not applied yet', async () => {
    listOfficeTasks.mockResolvedValue({ ok: false, reason: 'not_ready' });
    const res = await GET(makeGetReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('TASKS_NOT_READY');
  });

  it('503s with TASK_ACCESS_UNAVAILABLE when Supabase itself is unavailable', async () => {
    listOfficeTasks.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const res = await GET(makeGetReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('TASK_ACCESS_UNAVAILABLE');
  });
});

describe('POST /api/tasks — idempotency key', () => {
  it('400s with no x-idempotency-key header, and never calls the data layer', async () => {
    const res = await POST(makePostReq({ title: 'Do the thing' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(createManualOfficeTask).not.toHaveBeenCalled();
  });

  it('400s on a malformed (non-uuid) idempotency key', async () => {
    const res = await POST(makePostReq({ title: 'Do the thing' }, { 'x-idempotency-key': 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('passes a valid key through to the data layer', async () => {
    await POST(makePostReq({ title: 'Do the thing' }, { 'x-idempotency-key': VALID_KEY }));
    expect(createManualOfficeTask).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: VALID_KEY, actorId: 'op-1' }),
    );
  });
});

describe('POST /api/tasks — body validation', () => {
  it('400s a missing title', async () => {
    const res = await POST(makePostReq({}, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(400);
    expect(createManualOfficeTask).not.toHaveBeenCalled();
  });

  it('400s a blank/whitespace-only title', async () => {
    const res = await POST(makePostReq({ title: '   ' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(400);
  });

  it('400s a title over 200 characters', async () => {
    const res = await POST(makePostReq({ title: 'x'.repeat(201) }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(400);
  });

  it('400s a detail over 2000 characters', async () => {
    const res = await POST(
      makePostReq({ title: 'ok', detail: 'x'.repeat(2001) }, { 'x-idempotency-key': VALID_KEY }),
    );
    expect(res.status).toBe(400);
  });

  it('400s an unparsable dueAt', async () => {
    const res = await POST(
      makePostReq({ title: 'ok', dueAt: 'not-a-date' }, { 'x-idempotency-key': VALID_KEY }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_DUE_AT');
  });

  it('trims title/detail and normalizes a blank detail to null', async () => {
    await POST(
      makePostReq({ title: '  Do the thing  ', detail: '   ' }, { 'x-idempotency-key': VALID_KEY }),
    );
    expect(createManualOfficeTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Do the thing', detail: null }),
    );
  });
});

describe('POST /api/tasks — error-code mapping (the payload-aware idempotency replay contract)', () => {
  it('201s and returns the taskId on success', async () => {
    const res = await POST(makePostReq({ title: 'ok' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.taskId).toBe('new-task');
  });

  it('replays the same key + same payload as a 201 (idempotent retry) — modeled at the data-layer boundary as ok:true', async () => {
    // The RPC's replay-vs-conflict distinction lives in the RPC itself
    // (see the migration); at this boundary a replay is indistinguishable
    // from a fresh success, which is the whole point of idempotency.
    createManualOfficeTask.mockResolvedValue({ ok: true, taskId: 'same-task-id' });
    const res = await POST(makePostReq({ title: 'ok' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.taskId).toBe('same-task-id');
  });

  it('409s the same key reused for a DIFFERENT payload (idempotency_conflict)', async () => {
    createManualOfficeTask.mockResolvedValue({ ok: false, reason: 'idempotency_conflict' });
    const res = await POST(makePostReq({ title: 'ok' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('403s access_denied', async () => {
    createManualOfficeTask.mockResolvedValue({ ok: false, reason: 'access_denied' });
    const res = await POST(makePostReq({ title: 'ok' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(403);
  });

  it('400s invalid', async () => {
    createManualOfficeTask.mockResolvedValue({ ok: false, reason: 'invalid' });
    const res = await POST(makePostReq({ title: 'ok' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(400);
  });

  it('503s not_ready', async () => {
    createManualOfficeTask.mockResolvedValue({ ok: false, reason: 'not_ready' });
    const res = await POST(makePostReq({ title: 'ok' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('TASKS_NOT_READY');
  });

  it('500s a generic failure', async () => {
    createManualOfficeTask.mockResolvedValue({ ok: false, reason: 'failed' });
    const res = await POST(makePostReq({ title: 'ok' }, { 'x-idempotency-key': VALID_KEY }));
    expect(res.status).toBe(500);
  });
});
