// Office Tasks — the single task list (calls merge plan S1,
// docs/context/calls_merge_plan_2026-08.md). Thin wrappers around the two
// office_tasks_* SECURITY DEFINER RPCs (migrations/2026-08-28-office-tasks.sql)
// plus the list reads. All the real logic — the advisory-lock idempotency
// replay, the immutability triggers — lives in the database; this module is
// deliberately thin.
//
// S1 has exactly one producer (manual entry via createManualOfficeTask), but
// the list read already returns every source_system (per the plan's list
// fix) so later slices (S6 call_commitment, S8 quote_tool) need no per-
// SOURCE change when they start writing rows.
//
// EVERYTHING IS SHARED (Naldo's ruling, 2026-08-29): every task, manual
// included, is visible to and actionable by every operator — see
// listOfficeTasks' own comment below for the read side and
// migrations/2026-08-28-office-tasks.sql's third amendment for the RPC
// side (the creator-or-assignee ownership check is REMOVED, not widened).
// created_by/assigned_to still exist and are still stamped on every write —
// they no longer gate who may act, but they still say who created a task
// and (for a call_commitment task, per the rep-assignment ruling) who it's
// assigned to.
//
// The migration is NOT applied to any database yet (it creates functions/
// triggers, off the migration self-apply allowlist) — every function here
// treats "the tables/RPCs don't exist" as a distinct, expected outcome
// ('not_ready') rather than a generic failure, so the UI can say so plainly
// instead of showing a scary error.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { nameOf } from '@/lib/auth/supabaseServer';

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
  /**
   * "Everything is shared" ruling: a manual task's creator is no longer
   * obvious from context (anyone can see and act on it), so the list
   * surfaces who it was originally for. 'You' for the viewer's own task, a
   * resolved display name/email for someone else's, a generic fallback if
   * that resolution fails, and null for any non-manual task (those carry
   * no meaningful "personal" framing — see sourceLabel in OfficeTasksCard).
   */
  createdByLabel: string | null;
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
  created_by: string | null;
};

const TASK_SELECT =
  'id,source_system,title,detail,status,due_at,created_at,updated_at,blocked_reason,dismissal_reason,completed_at,dismissed_at,created_by';

function toOfficeTask(row: Row, actorId: string, creatorLabels: ReadonlyMap<string, string>): OfficeTask {
  let createdByLabel: string | null = null;
  if (row.source_system === 'manual') {
    if (row.created_by === actorId) createdByLabel = 'You';
    else if (row.created_by) createdByLabel = creatorLabels.get(row.created_by) ?? 'a teammate';
  }
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
    createdByLabel,
  };
}

/**
 * Resolves a display label for every distinct manual-task creator in `rows`
 * OTHER than `actorId` (the viewer's own tasks get the free 'You' label in
 * toOfficeTask, no lookup needed). Bounded by the task list itself (this
 * repo's Office Tasks is a small working list, not a paginated table), so a
 * per-id admin.getUserById lookup is cheap here — no need to page through
 * the WHOLE auth population the way adminUsers.ts's listAllRawUsers does
 * for the Settings → Accounts screen. Best-effort per id: a lookup failure
 * just leaves that creator unresolved (toOfficeTask's 'a teammate'
 * fallback), never fails the whole list read.
 */
async function resolveCreatorLabels(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  rows: Row[],
  actorId: string,
): Promise<Map<string, string>> {
  const distinctCreators = Array.from(
    new Set(
      rows
        .filter((r) => r.source_system === 'manual' && r.created_by && r.created_by !== actorId)
        .map((r) => r.created_by as string),
    ),
  );
  const labels = new Map<string, string>();
  await Promise.all(
    distinctCreators.map(async (id) => {
      try {
        const { data, error } = await db.auth.admin.getUserById(id);
        if (error || !data?.user) return;
        const label = nameOf(data.user.app_metadata) ?? data.user.email ?? null;
        if (label) labels.set(id, label);
      } catch {
        // best-effort — leave this id unresolved.
      }
    }),
  );
  return labels;
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
 * EVERY task, across every source_system and every operator — Naldo's
 * "everything is shared" ruling, 2026-08-29. This used to scope 'manual'
 * tasks to creator-or-assignee (matching an update RPC ownership check that
 * has since been REMOVED, not just widened — see
 * migrations/2026-08-28-office-tasks.sql's third amendment); that scoping
 * is gone. `actorId` is kept as a parameter, not for filtering, but to
 * compute each manual task's createdByLabel below ('You' for the viewer's
 * own task, a resolved name for someone else's).
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
  const rows = (data ?? []) as Row[];
  const creatorLabels = await resolveCreatorLabels(db, rows, actorId);
  return { ok: true, tasks: rows.map((row) => toOfficeTask(row, actorId, creatorLabels)) };
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
 * contract. 42501 now only ever means "p_actor was null" (the ownership
 * check that used to also raise it was REMOVED by the "everything is
 * shared" amendment — see that migration's header), and 23503 means the
 * task id doesn't exist; both still map to the same 'not_found' outcome so
 * a caller can't distinguish "no such actor" from "no such task" by
 * probing.
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
