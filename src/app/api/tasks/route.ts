// Office Tasks — the single task list (calls merge plan S1). Gated by
// requireOperator() (any operator; decision 1 drops the copilot's capability
// system in favor of this repo's plain operator/admin split). S1 has no
// producer besides manual entry, so POST only ever creates a 'manual' row —
// GET already returns every source_system so later slices need no read-side
// change when they start writing.
//
// EVERYTHING IS SHARED (2026-08-29 ruling): GET returns EVERY task, not just
// the caller's own — see officeTasks.ts's listOfficeTasks comment.
// createdByLabel rides along so the client can badge a manual task with
// whose it was ('You' / a resolved name / a generic fallback).
//
//   GET  /api/tasks               — every active task (open + blocked),
//                                    due soonest first.
//   GET  /api/tasks?status=history — every completed/dismissed task, most
//                                    recently touched first — the plan's fix
//                                    for finished work otherwise going
//                                    invisible.
//   POST /api/tasks               — create a manual task. Requires
//                                    x-idempotency-key (a client-minted uuid;
//                                    see OfficeTasksCard's createKeyRef).

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import {
  createManualOfficeTask,
  listOfficeTasks,
  type OfficeTask,
  type OfficeTaskListView,
} from '@/lib/officeTasks';
import { highLevelContactUrlFromEnv } from '@/lib/highLevelLinks';
import { readIdempotencyKey, taskError } from './taskRequest';

export const runtime = 'nodejs';

function taskResponse(task: OfficeTask) {
  return {
    id: task.id,
    sourceSystem: task.sourceSystem,
    title: task.title,
    detail: task.detail,
    status: task.status,
    dueAt: task.dueAt,
    createdAt: task.createdAt,
    blockedReason: task.blockedReason,
    dismissalReason: task.dismissalReason,
    completedAt: task.completedAt,
    dismissedAt: task.dismissedAt,
    createdByLabel: task.createdByLabel,
    // Who it is assigned to, as a label only. Assignment never gates who may
    // see or act on a task (the everything-is-shared ruling) — the /tasks
    // page uses it to show and filter by owner.
    assignedToLabel: task.assignedToLabel,
    // The customer this task is about. contactId is a HighLevel contact id,
    // which is also what /customers/[contactId] takes as its route id, so the
    // client links straight to it with no further lookup.
    //
    // highLevelUrl is built HERE rather than in the client, because building
    // it needs HIGHLEVEL_LOCATION_ID and OfficeTasksCard is a client
    // component: reading process.env from a module a client component imports
    // is its own bug. null when this environment has no location id
    // configured, and the client then simply renders no HighLevel link.
    customerContactId: task.customerContactId,
    customerName: task.customerName,
    highLevelUrl: highLevelContactUrlFromEnv(task.customerContactId),
  };
}

export async function GET(request: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const operator = await getOperator();
  if (!operator) return taskError('TASK_ACCESS_DENIED', 'You do not have access to Office tasks.', 403);

  const view: OfficeTaskListView = request.nextUrl.searchParams.get('status') === 'history' ? 'history' : 'active';
  const result = await listOfficeTasks(operator.id, view);

  if (!result.ok) {
    return result.reason === 'not_ready'
      ? taskError('TASKS_NOT_READY', 'Office tasks are not available in this environment yet.', 503)
      : taskError('TASK_ACCESS_UNAVAILABLE', 'Task access is temporarily unavailable.', 503);
  }

  const response = NextResponse.json({ tasks: result.tasks.map(taskResponse) });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const operator = await getOperator();
  if (!operator) return taskError('TASK_ACCESS_DENIED', 'You do not have access to Office tasks.', 403);

  const key = readIdempotencyKey(request);
  if (!key) {
    return taskError('IDEMPOTENCY_KEY_REQUIRED', 'A valid idempotency key is required for task creation.', 400);
  }

  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    detail?: unknown;
    dueAt?: unknown;
  } | null;
  if (!body || typeof body.title !== 'string') {
    return taskError('INVALID_TASK', 'Enter a task title.', 400);
  }

  const title = body.title.trim();
  if (!title || title.length > 200) {
    return taskError('INVALID_TASK', 'Task titles must be between 1 and 200 characters.', 400);
  }
  if (body.detail !== undefined && body.detail !== null && typeof body.detail !== 'string') {
    return taskError('INVALID_TASK', 'Task details must be text.', 400);
  }
  const detail = typeof body.detail === 'string' ? body.detail.trim() || null : null;
  if (detail && detail.length > 2000) {
    return taskError('INVALID_TASK', 'Task details cannot exceed 2,000 characters.', 400);
  }

  let dueAt: string | null = null;
  if (body.dueAt !== undefined && body.dueAt !== null && body.dueAt !== '') {
    if (typeof body.dueAt !== 'string') {
      return taskError('INVALID_DUE_AT', 'Choose a valid future due time.', 400);
    }
    const dueDate = new Date(body.dueAt);
    if (Number.isNaN(dueDate.getTime())) {
      return taskError('INVALID_DUE_AT', 'Choose a valid future due time.', 400);
    }
    dueAt = dueDate.toISOString();
  }

  const result = await createManualOfficeTask({
    title,
    detail,
    dueAt,
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
      case 'access_denied':
        return taskError('TASK_ACCESS_DENIED', 'You do not have access to create this task.', 403);
      case 'invalid':
        return taskError('INVALID_TASK', 'The task could not be created from those details.', 400);
      default:
        return taskError('TASK_CREATE_FAILED', 'The task could not be saved.', 500);
    }
  }

  const response = NextResponse.json({ taskId: result.taskId }, { status: 201 });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
