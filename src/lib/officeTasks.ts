// Office Tasks — the single task list (calls merge plan S1,
// docs/context/calls_merge_plan_2026-08.md). Thin wrappers around the two
// office_tasks_* SECURITY DEFINER RPCs (migrations/2026-08-28-office-tasks.sql)
// plus the list reads. All the real logic — the advisory-lock idempotency
// replay, the immutability triggers, the creator-or-assignee authorization —
// lives in the database; this module is deliberately thin.
//
// S1 has exactly one producer (manual entry via createManualOfficeTask), but
// the list read already returns every source_system (per the plan's list
// fix) so later slices (S6 call_commitment, S8 quote_tool) need no read-side
// change when they start writing rows.
//
// The migration is NOT applied to any database yet (it creates functions/
// triggers, off the migration self-apply allowlist) — every function here
// treats "the tables/RPCs don't exist" as a distinct, expected outcome
// ('not_ready') rather than a generic failure, so the UI can say so plainly
// instead of showing a scary error.

import { getSupabaseServiceClient } from '@/lib/supabase';

export type OfficeTaskSourceSystem = 'manual' | 'call_commitment' | 'quote_tool';
export type OfficeTaskStatus = 'open' | 'blocked' | 'completed' | 'dismissed';
export type OfficeTaskListView = 'active' | 'history';

export type OfficeTask = {
  id: string;
  sourceSystem: OfficeTaskSourceSystem;
  title: string;
  detail: string | null;
  status: OfficeTaskStatus;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  blockedReason: string | null;
  dismissalReason: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
};

type Row = {
  id: string;
  source_system: OfficeTaskSourceSystem;
  title: string;
  detail: string | null;
  status: OfficeTaskStatus;
  due_at: string;
  created_at: string;
  updated_at: string;
  blocked_reason: string | null;
  dismissal_reason: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
};

const TASK_SELECT =
  'id,source_system,title,detail,status,due_at,created_at,updated_at,blocked_reason,dismissal_reason,completed_at,dismissed_at';

function toOfficeTask(row: Row): OfficeTask {
  return {
    id: row.id,
    sourceSystem: row.source_system,
    title: row.title,
    detail: row.detail,
    status: row.status,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blockedReason: row.blocked_reason,
    dismissalReason: row.dismissal_reason,
    completedAt: row.completed_at,
    dismissedAt: row.dismissed_at,
  };
}

/** Postgres/PostgREST error code off a Supabase error object, or null. */
export function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * True when the error means "the office_tasks schema isn't applied here yet"
 * rather than a real failure: 42P01/PGRST205 (table missing — PostgREST's own
 * "not found in schema cache" code, plus the raw Postgres one for completeness)
 * for the plain SELECT below, 42883/PGRST202 (function missing) for the RPCs.
 */
export function isOfficeTasksSchemaUnavailable(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code === '42P01' || code === 'PGRST205' || code === '42883' || code === 'PGRST202';
}

export type ListOfficeTasksResult =
  | { ok: true; tasks: OfficeTask[] }
  | { ok: false; reason: 'not_ready' | 'unavailable' };

/**
 * The actor's own tasks (creator OR assignee — matches the update RPC's
 * ownership rule, so every task an operator can see is one they can also
 * act on), across every source_system.
 *
 *   view: 'active'  -> open + blocked, due soonest first (the working list).
 *   view: 'history' -> completed + dismissed, most recently touched first —
 *                       so finished work stays reachable instead of vanishing.
 */
export async function listOfficeTasks(
  actorId: string,
  view: OfficeTaskListView,
): Promise<ListOfficeTasksResult> {
  const db = getSupabaseServiceClient();
  if (!db) return { ok: false, reason: 'unavailable' };

  const statuses = view === 'history' ? ['completed', 'dismissed'] : ['open', 'blocked'];
  let query = db
    .from('office_tasks')
    .select(TASK_SELECT)
    .or(`created_by.eq.${actorId},assigned_to.eq.${actorId}`)
    .in('status', statuses);
  query = view === 'history'
    ? query.order('updated_at', { ascending: false }).order('id', { ascending: false })
    : query.order('due_at', { ascending: true }).order('id', { ascending: true });

  const { data, error } = await query;
  if (error) {
    return {
      ok: false,
      reason: isOfficeTasksSchemaUnavailable(error) ? 'not_ready' : 'unavailable',
    };
  }
  return { ok: true, tasks: (data ?? []).map((row) => toOfficeTask(row as Row)) };
}

export type CreateOfficeTaskInput = {
  title: string;
  detail: string | null;
  dueAt: string | null;
  actorId: string;
  idempotencyKey: string;
};

export type CreateOfficeTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; reason: 'not_ready' | 'unavailable' | 'idempotency_conflict' | 'access_denied' | 'invalid' | 'failed' };

/** office_tasks_create_manual — see the RPC's own comment for the full contract. */
export async function createManualOfficeTask(input: CreateOfficeTaskInput): Promise<CreateOfficeTaskResult> {
  const db = getSupabaseServiceClient();
  if (!db) return { ok: false, reason: 'unavailable' };

  const { data, error } = await db.rpc('office_tasks_create_manual', {
    p_title: input.title,
    p_detail: input.detail,
    p_due_at: input.dueAt,
    p_actor: input.actorId,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    if (isOfficeTasksSchemaUnavailable(error)) return { ok: false, reason: 'not_ready' };
    const code = databaseErrorCode(error);
    if (code === '23505') return { ok: false, reason: 'idempotency_conflict' };
    if (code === '42501') return { ok: false, reason: 'access_denied' };
    if (code === '22023' || code === '23502' || code === '23514') return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, taskId: data as string };
}

export type UpdateOfficeTaskStatusInput = {
  taskId: string;
  status: 'blocked' | 'completed' | 'dismissed';
  reason: string | null;
  actorId: string;
  idempotencyKey: string;
};

export type UpdateOfficeTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; reason: 'not_ready' | 'unavailable' | 'idempotency_conflict' | 'not_found' | 'state_conflict' | 'failed' };

/**
 * office_tasks_update_status — see the RPC's own comment for the full
 * contract. 42501 (not the task's creator/assignee) and 23503 (task id
 * doesn't exist) BOTH map to 'not_found': a non-owner gets the identical
 * response for "not yours" and "doesn't exist", so probing task ids can't
 * distinguish the two.
 */
export async function updateOfficeTaskStatus(input: UpdateOfficeTaskStatusInput): Promise<UpdateOfficeTaskResult> {
  const db = getSupabaseServiceClient();
  if (!db) return { ok: false, reason: 'unavailable' };

  const { data, error } = await db.rpc('office_tasks_update_status', {
    p_task_id: input.taskId,
    p_status: input.status,
    p_reason: input.reason,
    p_actor: input.actorId,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    if (isOfficeTasksSchemaUnavailable(error)) return { ok: false, reason: 'not_ready' };
    const code = databaseErrorCode(error);
    if (code === '23505') return { ok: false, reason: 'idempotency_conflict' };
    if (code === '42501' || code === '23503') return { ok: false, reason: 'not_found' };
    if (code === '22023' || code === '23514') return { ok: false, reason: 'state_conflict' };
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, taskId: data as string };
}
