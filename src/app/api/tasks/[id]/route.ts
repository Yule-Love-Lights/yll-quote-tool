// PATCH /api/tasks/[id] — block/complete/dismiss an Office Task. Any
// operator may act on any task (Naldo's 2026-08-29 everything-is-shared
// ruling; office_tasks_update_status no longer enforces creator-or-assignee
// ownership). Requires x-idempotency-key.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { updateOfficeTaskStatus } from '@/lib/officeTasks';
import { isUuid, readIdempotencyKey, taskError } from '../taskRequest';

export const runtime = 'nodejs';

type TaskAction = 'blocked' | 'completed' | 'dismissed';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOperator();
  if (denied) return denied;
  const operator = await getOperator();
  if (!operator) return taskError('TASK_ACCESS_DENIED', 'You do not have access to Office tasks.', 403);

  const key = readIdempotencyKey(request);
  if (!key) {
    return taskError('IDEMPOTENCY_KEY_REQUIRED', 'A valid idempotency key is required for task updates.', 400);
  }

  const { id } = await params;
  if (!isUuid(id)) return taskError('TASK_NOT_FOUND', 'Task not found.', 404);

  const body = (await request.json().catch(() => null)) as {
    status?: unknown;
    reason?: unknown;
  } | null;
  if (!body || !['blocked', 'completed', 'dismissed'].includes(String(body.status))) {
    return taskError('INVALID_TASK_ACTION', 'Choose a valid task action.', 400);
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    return taskError('INVALID_TASK_ACTION', 'Task reasons must be text.', 400);
  }

  const action = body.status as TaskAction;
  const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;
  if ((action === 'blocked' || action === 'dismissed') && !reason) {
    return taskError(
      'TASK_REASON_REQUIRED',
      action === 'blocked' ? 'Enter a reason before blocking this task.' : 'Enter a reason before dismissing this task.',
      400,
    );
  }
  if (action === 'completed' && reason) {
    return taskError('INVALID_TASK_ACTION', 'Completed tasks do not accept a reason.', 400);
  }
  if (reason && reason.length > 500) {
    return taskError('INVALID_TASK_ACTION', 'Task reasons cannot exceed 500 characters.', 400);
  }

  const result = await updateOfficeTaskStatus({
    taskId: id,
    status: action,
    reason,
    actorId: operator.id,
    idempotencyKey: key,
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'not_ready':
        return taskError('TASKS_NOT_READY', 'Office tasks are not available in this environment yet.', 503);
      case 'unavailable':
        return taskError('TASK_ACCESS_UNAVAILABLE', 'Task access is temporarily unavailable.', 503);
      case 'idempotency_conflict':
        return taskError('IDEMPOTENCY_CONFLICT', 'That request key was already used for a different task action.', 409);
      // Not the owner, or the id doesn't exist — same response either way so
      // a non-owner can't tell "not yours" from "doesn't exist" by probing.
      case 'not_found':
        return taskError('TASK_NOT_FOUND', 'Task not found.', 404);
      case 'state_conflict':
        return taskError(
          'TASK_STATE_CONFLICT',
          'This task changed before the action could be saved. Refresh the list and try again.',
          409,
        );
      default:
        return taskError('TASK_UPDATE_FAILED', 'The task action could not be saved.', 500);
    }
  }

  const response = NextResponse.json({ taskId: result.taskId, status: action });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
