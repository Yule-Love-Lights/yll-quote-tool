'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

// Office Tasks — the single task list (calls merge plan S1). Ported from
// yll-call-copilot's OfficeTasksCard.tsx onto this dashboard, adapted for
// requireOperator() auth (no capability check) and the plan's list fix: a
// history toggle so completed/dismissed tasks stay reachable instead of
// disappearing. S1 has no producer besides manual entry, so every task
// created here is 'manual' — sourceSystem still rides through the API
// response so later slices (call commitments, the follow-up strip) need no
// change to this component's data shape.
//
// EVERYTHING IS SHARED (2026-08-29 ruling): every task — manual included —
// is visible to and actionable by every operator (see officeTasks.ts's
// listOfficeTasks comment). "My open work" became just "Open work" for
// that reason. A manual task now carries createdByLabel ('You' / a
// resolved teammate name / a generic fallback) so people still know whose
// it was, shown via personalLabel below, next to sourceLabel's "From a
// call" badge for non-manual tasks.
//
// The idempotency-key-per-action pattern (createKeyRef / actionKeysRef) is
// what makes the server's idempotency contract real end to end: a network
// failure or a double-tap reuses the SAME key, so the retry either lands
// once or gets told the exact same result back — never a duplicate task or
// a duplicate status change. A key is only invalidated (never reused) after
// a response that PROVES the request did not go through (a 4xx); on an
// ambiguous outcome (5xx/408/425/429 — server errored, timed out, or was
// asked to slow down) the key survives so the retry replays the original
// attempt instead of risking a second one.

type TaskSourceSystem = 'manual' | 'call_commitment' | 'quote_tool';
type TaskStatus = 'open' | 'blocked' | 'completed' | 'dismissed';
type TaskAction = 'blocked' | 'completed' | 'dismissed';
type ViewMode = 'active' | 'history';
type LoadState = 'loading' | 'ready' | 'error' | 'unavailable';

interface OfficeTask {
  id: string;
  sourceSystem: TaskSourceSystem;
  title: string;
  detail: string | null;
  status: TaskStatus;
  dueAt: string;
  createdAt: string;
  blockedReason: string | null;
  dismissalReason: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
  createdByLabel: string | null;
}

interface ActionEditor {
  taskId: string;
  action: 'blocked' | 'dismissed';
  reason: string;
}

interface ApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

type TaskLoadResult =
  | { state: 'ready'; tasks: OfficeTask[] }
  | { state: 'error' | 'unavailable'; message: string };

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
  const code = typeof body?.error?.code === 'string' ? body.error.code : null;
  const message = typeof body?.error?.message === 'string' ? body.error.message : fallback;
  return { code, message };
}

/**
 * Whether a failed mutation's outcome is genuinely UNKNOWN (the server may
 * have applied it anyway) vs. definitely rejected. Only the ambiguous case
 * keeps the idempotency key alive for a safe retry.
 */
export function isAmbiguousMutationFailure(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

export function formatDueTime(value: string): string {
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return 'Due time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(due);
}

/** History rows show when the task was resolved, not when it was due. */
export function resolvedTimeFor(task: Pick<OfficeTask, 'completedAt' | 'dismissedAt'>): string | null {
  const at = task.completedAt ?? task.dismissedAt;
  return at ? formatDueTime(at) : null;
}

/**
 * Fix round (staff lens, calls merge S6), updated for Naldo's 2026-08-29
 * everything-is-shared ruling: ALL tasks (manual included) are visible to
 * and actionable by every operator. The badge distinguishes ORIGIN, not
 * access: call-derived tasks carry "From a call", manual tasks carry the
 * Personal label below. Without a visible marker, two staffers
 * could independently work the same call_commitment task (e.g. both call the
 * same customer back about the same promised quote) with neither aware the
 * other already saw it. null for 'manual' (no badge — the common case).
 */
export function sourceLabel(sourceSystem: TaskSourceSystem): string | null {
  if (sourceSystem === 'manual') return null;
  if (sourceSystem === 'call_commitment') return 'From a call';
  return 'Shared';
}

/**
 * RULING (2026-08-29, "everything is shared"): a manual task is no longer
 * private — every operator can see AND ACT ON it, same as a call_commitment
 * task always could — so it needs its own small badge saying whose it
 * originally was ("so people still know whose it was"). null for a
 * non-manual task (sourceLabel covers those instead — the two badges are
 * mutually exclusive per task).
 */
export function personalLabel(sourceSystem: TaskSourceSystem, createdByLabel: string | null): string | null {
  if (sourceSystem !== 'manual') return null;
  return createdByLabel ? `Personal (${createdByLabel})` : 'Personal';
}

async function requestTasks(view: ViewMode): Promise<TaskLoadResult> {
  const url = view === 'history' ? '/api/tasks?status=history' : '/api/tasks';
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      const error = await responseError(response, 'Tasks could not be loaded.');
      const unavailable =
        response.status === 503 && (error.code === 'TASKS_NOT_READY' || error.code === 'TASK_ACCESS_UNAVAILABLE');
      return { state: unavailable ? 'unavailable' : 'error', message: error.message };
    }

    const body = (await response.json()) as { tasks?: unknown };
    if (!Array.isArray(body.tasks)) throw new Error('invalid task response');
    return { state: 'ready', tasks: body.tasks as OfficeTask[] };
  } catch {
    return { state: 'error', message: 'Tasks could not be loaded. Check your connection and try again.' };
  }
}

export default function OfficeTasksCard() {
  const [view, setView] = useState<ViewMode>('active');
  const [tasks, setTasks] = useState<OfficeTask[] | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadMessage, setLoadMessage] = useState('Loading tasks…');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionEditor, setActionEditor] = useState<ActionEditor | null>(null);
  const [actionError, setActionError] = useState<{ taskId: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const loadSequenceRef = useRef(0);
  const creatingRef = useRef(false);
  const createKeyRef = useRef<string | null>(null);
  const pendingTaskIdsRef = useRef(new Set<string>());
  const actionKeysRef = useRef(new Map<string, string>());

  const applyTaskLoad = useCallback((sequence: number, result: TaskLoadResult) => {
    if (sequence !== loadSequenceRef.current) return;
    if (result.state === 'ready') {
      setTasks(result.tasks);
      setLoadState('ready');
      setLoadMessage('');
      return;
    }
    setLoadState(result.state);
    setLoadMessage(result.message);
  }, []);

  const loadTasks = useCallback(
    async (targetView: ViewMode) => {
      const sequence = ++loadSequenceRef.current;
      setLoadState('loading');
      setLoadMessage(targetView === 'history' ? 'Loading history…' : 'Loading tasks…');
      applyTaskLoad(sequence, await requestTasks(targetView));
    },
    [applyTaskLoad],
  );

  // Mount + every view change re-fetches from that view's endpoint.
  useEffect(() => {
    let active = true;
    const sequence = ++loadSequenceRef.current;
    void requestTasks(view).then((result) => {
      if (active) applyTaskLoad(sequence, result);
    });
    return () => {
      active = false;
    };
  }, [view, applyTaskLoad]);

  function resetCreateIntent() {
    createKeyRef.current = null;
    setCreateError(null);
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle || creatingRef.current || loadState !== 'ready') return;

    let serializedDueAt: string | null = null;
    if (dueAt) {
      const selectedDueAt = new Date(dueAt);
      const invalidDueAt =
        Number.isNaN(selectedDueAt.getTime()) || (selectedDueAt.getTime() <= Date.now() && createKeyRef.current === null);
      if (invalidDueAt) {
        setCreateError('Choose a future due time or leave it blank for the 24-hour default.');
        return;
      }
      serializedDueAt = selectedDueAt.toISOString();
    }

    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;

    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': key },
        body: JSON.stringify({ title: normalizedTitle, detail: detail.trim() || null, dueAt: serializedDueAt }),
      });

      if (!response.ok) {
        const error = await responseError(response, 'The task could not be created.');
        if (!isAmbiguousMutationFailure(response.status)) createKeyRef.current = null;
        setCreateError(error.message);
        return;
      }

      createKeyRef.current = null;
      setTitle('');
      setDetail('');
      setDueAt('');
      setAnnouncement(`Created task: ${normalizedTitle}.`);
      // A new task is always 'open' — jump back to the active view so it's
      // visible immediately, even if the operator was browsing history.
      if (view === 'history') setView('active');
      else await loadTasks('active');
    } catch {
      setCreateError('We could not confirm whether the task was created. Try again to safely replay the same request.');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  function openReasonEditor(taskId: string, action: 'blocked' | 'dismissed') {
    if (pendingTaskIdsRef.current.has(taskId)) return;
    setActionError(null);
    setActionEditor({ taskId, action, reason: '' });
  }

  async function updateTask(task: OfficeTask, action: TaskAction, rawReason?: string) {
    if (pendingTaskIdsRef.current.has(task.id) || loadState !== 'ready') return;
    const reason = rawReason?.trim() || null;
    if ((action === 'blocked' || action === 'dismissed') && !reason) {
      setActionError({ taskId: task.id, message: 'Enter a reason before saving this action.' });
      return;
    }

    const signature = JSON.stringify([task.id, action, reason]);
    const key = actionKeysRef.current.get(signature) ?? crypto.randomUUID();
    actionKeysRef.current.set(signature, key);
    pendingTaskIdsRef.current.add(task.id);
    setPendingTaskIds(new Set(pendingTaskIdsRef.current));
    setActionError(null);

    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': key },
        body: JSON.stringify({ status: action, reason }),
      });

      if (!response.ok) {
        const error = await responseError(response, 'The task action could not be saved.');
        if (!isAmbiguousMutationFailure(response.status)) actionKeysRef.current.delete(signature);
        setActionError({ taskId: task.id, message: error.message });
        return;
      }

      actionKeysRef.current.delete(signature);
      setTasks((current) => {
        if (!current) return current;
        if (action === 'blocked') {
          return current.map((candidate) =>
            candidate.id === task.id ? { ...candidate, status: 'blocked', blockedReason: reason } : candidate,
          );
        }
        // completed/dismissed leave the active view — they now belong to history.
        return current.filter((candidate) => candidate.id !== task.id);
      });
      setActionEditor((current) => (current?.taskId === task.id ? null : current));
      setAnnouncement(
        action === 'blocked'
          ? `Blocked task: ${task.title}.`
          : action === 'completed'
            ? `Completed task: ${task.title}.`
            : `Dismissed task: ${task.title}.`,
      );
    } catch {
      setActionError({
        taskId: task.id,
        message: 'We could not confirm the task action. Try again to safely replay the same request.',
      });
    } finally {
      pendingTaskIdsRef.current.delete(task.id);
      setPendingTaskIds(new Set(pendingTaskIdsRef.current));
    }
  }

  function submitReason(event: FormEvent<HTMLFormElement>, task: OfficeTask) {
    event.preventDefault();
    if (!actionEditor || actionEditor.taskId !== task.id) return;
    void updateTask(task, actionEditor.action, actionEditor.reason);
  }

  const canMutate = loadState === 'ready' && view === 'active';

  return (
    <section
      className="rounded-lg border p-4 mb-8"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      aria-labelledby="office-tasks-heading"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
            Office Tasks
          </p>
          <h2 id="office-tasks-heading" className="mt-1 text-base font-semibold" style={{ color: 'var(--op-text)' }}>
            {view === 'history' ? 'Completed & dismissed' : 'Open work'}
          </h2>
          {view === 'active' && (
            <p className="mt-1 text-sm leading-5" style={{ color: 'var(--op-text-dim)' }}>
              New tasks are due 24 hours after creation unless you choose another future time.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {tasks !== null && loadState === 'ready' && view === 'active' ? (
            <span
              className="w-fit rounded-full px-2.5 py-1 text-xs font-medium"
              style={{ background: 'var(--brand-cream)', color: 'var(--brand-evergreen-3)' }}
            >
              {tasks.length} active
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setView((v) => (v === 'active' ? 'history' : 'active'))}
            className="min-h-11 rounded-md border px-3 py-2 text-sm font-semibold"
            style={{ borderColor: 'var(--op-border-mid)', color: 'var(--op-text)', background: 'var(--op-bg-raised)' }}
          >
            {view === 'active' ? 'View history' : 'Back to open work'}
          </button>
        </div>
      </div>

      {view === 'active' && (
        <form className="mt-4 grid gap-3" onSubmit={createTask} aria-busy={creating}>
          <div>
            <label htmlFor="office-task-title" className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
              Task title
            </label>
            <input
              id="office-task-title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                resetCreateIntent();
              }}
              maxLength={200}
              required
              disabled={loadState !== 'ready' || creating}
              autoComplete="off"
              className="mt-1 min-h-11 w-full rounded-md border px-3 py-2 text-base disabled:opacity-70 sm:text-sm"
              style={{ borderColor: 'var(--op-border-mid)', color: 'var(--op-text)' }}
            />
          </div>
          <div>
            <label htmlFor="office-task-detail" className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
              Details <span className="font-normal" style={{ color: 'var(--op-text-dim)' }}>(optional)</span>
            </label>
            <textarea
              id="office-task-detail"
              value={detail}
              onChange={(event) => {
                setDetail(event.target.value);
                resetCreateIntent();
              }}
              maxLength={2000}
              rows={2}
              disabled={loadState !== 'ready' || creating}
              className="mt-1 w-full rounded-md border px-3 py-2 text-base disabled:opacity-70 sm:text-sm"
              style={{ borderColor: 'var(--op-border-mid)', color: 'var(--op-text)' }}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div>
              <label htmlFor="office-task-due-at" className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
                Due time <span className="font-normal" style={{ color: 'var(--op-text-dim)' }}>(optional)</span>
              </label>
              <input
                id="office-task-due-at"
                type="datetime-local"
                value={dueAt}
                onChange={(event) => {
                  setDueAt(event.target.value);
                  resetCreateIntent();
                }}
                disabled={loadState !== 'ready' || creating}
                aria-describedby="office-task-due-help"
                className="mt-1 min-h-11 w-full rounded-md border px-3 py-2 text-base disabled:opacity-70 sm:text-sm"
                style={{ borderColor: 'var(--op-border-mid)', color: 'var(--op-text)' }}
              />
              <p id="office-task-due-help" className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
                Leave blank to use the 24-hour default.
              </p>
            </div>
            <button
              type="submit"
              disabled={loadState !== 'ready' || creating || !title.trim()}
              className="min-h-11 rounded-md px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
            >
              {creating ? 'Adding…' : 'Add task'}
            </button>
          </div>
          {createError ? (
            <p className="text-sm" style={{ color: 'var(--op-danger)' }} role="alert">
              {createError}
            </p>
          ) : null}
        </form>
      )}

      {loadState !== 'ready' ? (
        <div
          className="mt-4 rounded-md border p-3 text-sm"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}
          role={loadState === 'error' ? 'alert' : 'status'}
        >
          <p>{loadMessage}</p>
          {loadState === 'error' || loadState === 'unavailable' ? (
            <button
              type="button"
              onClick={() => void loadTasks(view)}
              className="mt-2 min-h-11 rounded-md border px-3 py-2 font-semibold"
              style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : tasks?.length === 0 ? (
        <p className="mt-4 rounded-md p-3 text-sm" style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}>
          {view === 'history' ? 'No completed or dismissed tasks yet.' : 'No open or blocked tasks. New tasks will appear here.'}
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {tasks?.map((task) => {
            const pending = pendingTaskIds.has(task.id);
            const editing = actionEditor?.taskId === task.id ? actionEditor : null;
            const resolvedTime = view === 'history' ? resolvedTimeFor(task) : null;
            return (
              <li key={task.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--op-border)' }} aria-busy={pending}>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
                        {task.title}
                      </h3>
                      <span
                        className="rounded-full px-2 py-0.5 text-xs font-semibold"
                        style={
                          task.status === 'blocked'
                            ? { background: '#FBE6DF', color: '#7A2E20' }
                            : task.status === 'completed'
                              ? { background: 'var(--brand-cream)', color: 'var(--brand-evergreen-3)' }
                              : task.status === 'dismissed'
                                ? { background: 'var(--op-bg)', color: 'var(--op-text-dim)' }
                                : { background: 'var(--brand-cream)', color: 'var(--brand-evergreen-3)' }
                        }
                      >
                        {task.status === 'blocked'
                          ? 'Blocked'
                          : task.status === 'completed'
                            ? 'Completed'
                            : task.status === 'dismissed'
                              ? 'Dismissed'
                              : 'Open'}
                      </span>
                      {sourceLabel(task.sourceSystem) ? (
                        <span
                          className="rounded-full px-2 py-0.5 text-xs font-semibold"
                          style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}
                          title="Visible to every operator. Anyone can pick this up."
                        >
                          {sourceLabel(task.sourceSystem)}
                        </span>
                      ) : null}
                      {personalLabel(task.sourceSystem, task.createdByLabel) ? (
                        <span
                          className="rounded-full px-2 py-0.5 text-xs font-semibold"
                          style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}
                          title="Visible to every operator. Anyone can pick this up."
                        >
                          {personalLabel(task.sourceSystem, task.createdByLabel)}
                        </span>
                      ) : null}
                    </div>
                    {task.detail ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5" style={{ color: 'var(--op-text-dim)' }}>
                        {task.detail}
                      </p>
                    ) : null}
                    {view === 'history' ? (
                      resolvedTime ? (
                        <p className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
                          {task.status === 'completed' ? 'Completed' : 'Dismissed'} {resolvedTime}
                        </p>
                      ) : null
                    ) : (
                      <p className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>Due {formatDueTime(task.dueAt)}</p>
                    )}
                    {task.status === 'blocked' && task.blockedReason ? (
                      <p className="mt-2 rounded-md px-2.5 py-2 text-sm" style={{ background: '#FFF4EF', color: '#6D2A20' }}>
                        <span className="font-semibold">Blocked because:</span> {task.blockedReason}
                      </p>
                    ) : null}
                    {task.status === 'dismissed' && task.dismissalReason ? (
                      <p className="mt-2 rounded-md p-2 text-sm" style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}>
                        <span className="font-semibold">Dismissed because:</span> {task.dismissalReason}
                      </p>
                    ) : null}
                  </div>
                  {view === 'active' ? (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button
                        type="button"
                        aria-label={`Complete task: ${task.title}`}
                        onClick={() => void updateTask(task, 'completed')}
                        disabled={pending || !canMutate}
                        className="min-h-11 rounded-md px-3 py-2 text-sm font-semibold disabled:opacity-50"
                        style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
                      >
                        {pending ? 'Saving…' : 'Complete'}
                      </button>
                      {task.status === 'open' ? (
                        <button
                          type="button"
                          aria-label={`Block task: ${task.title}`}
                          onClick={() => openReasonEditor(task.id, 'blocked')}
                          disabled={pending || !canMutate}
                          className="min-h-11 rounded-md border px-3 py-2 text-sm font-semibold disabled:opacity-50"
                          style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
                        >
                          Block
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Dismiss task: ${task.title}`}
                        onClick={() => openReasonEditor(task.id, 'dismissed')}
                        disabled={pending || !canMutate}
                        className="min-h-11 rounded-md border px-3 py-2 text-sm font-semibold disabled:opacity-50"
                        style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : null}
                </div>

                {editing ? (
                  <form className="mt-3 rounded-md p-3" style={{ background: 'var(--op-bg)' }} onSubmit={(event) => submitReason(event, task)}>
                    <label htmlFor={`office-task-reason-${task.id}`} className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
                      {editing.action === 'blocked' ? 'Reason for blocking' : 'Reason for dismissing'}
                    </label>
                    <textarea
                      id={`office-task-reason-${task.id}`}
                      value={editing.reason}
                      onChange={(event) => {
                        setActionEditor({ ...editing, reason: event.target.value });
                        setActionError(null);
                      }}
                      maxLength={500}
                      rows={2}
                      required
                      disabled={pending}
                      className="mt-1 w-full rounded-md border px-3 py-2 text-base disabled:opacity-70 sm:text-sm"
                      style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="submit"
                        aria-label={`${editing.action === 'blocked' ? 'Confirm block' : 'Confirm dismiss'} task: ${task.title}`}
                        disabled={pending || !editing.reason.trim()}
                        className="min-h-11 rounded-md px-3 py-2 text-sm font-semibold disabled:opacity-50"
                        style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
                      >
                        {pending ? 'Saving…' : editing.action === 'blocked' ? 'Confirm block' : 'Confirm dismiss'}
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel ${editing.action} for task: ${task.title}`}
                        onClick={() => {
                          setActionEditor(null);
                          setActionError(null);
                        }}
                        disabled={pending}
                        className="min-h-11 rounded-md border px-3 py-2 text-sm font-semibold disabled:opacity-50"
                        style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {actionError?.taskId === task.id ? (
                  <p className="mt-2 text-sm" style={{ color: 'var(--op-danger)' }} role="alert">
                    {actionError.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
