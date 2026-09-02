'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notifyOfficeTasksChanged } from './officeTasksEvents';

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
// TWO VARIANTS, ONE IMPLEMENTATION (2026-08-29). The same component renders
// the dashboard card and the /tasks page, because both need identical fetch,
// action and idempotency behaviour and a second copy would drift:
//
//   variant="card" (the default, src/app/page.tsx) — the working few. The
//     next CARD_TASK_LIMIT tasks by due time, the add-task form, and a link
//     out to /tasks. No history, no filters: the dashboard is a glance, not
//     a workbench.
//   variant="page" (src/app/tasks/page.tsx) — the whole list. Active and
//     History tabs, filter by source and by assignee, and a sort control.
//
// Everything below that is not explicitly variant-gated is shared by both.
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
type Variant = 'card' | 'page';
/** 'all' plus one entry per source system actually present in the loaded list. */
type SourceFilter = 'all' | TaskSourceSystem;
/** 'all', the sentinel for nothing assigned, or an assignee's display label. */
type OwnerFilter = string;
type SortMode = 'due' | 'created' | 'resolved';

/** The owner-filter value meaning "nobody is assigned to this". A literal
 *  sentinel rather than null so it can live in a <select> value. */
const UNASSIGNED = '\u0000unassigned';
/** How many tasks the dashboard card shows before sending you to /tasks. */
export const CARD_TASK_LIMIT = 3;

/**
 * Each view's natural order: the working list reads soonest-due, History reads
 * most-recently-finished.
 *
 * Exported and used in all THREE places that need it (the first render, a tab
 * click, and a URL that changed underneath us) precisely so they cannot drift.
 * The premerge technical lens's central question was whether landing on
 * History by link sorts the same as clicking through to it; with one function
 * answering for every path, that is true by construction rather than by
 * three copies happening to agree.
 */
export function sortDefaultFor(view: ViewMode): SortMode {
  return view === 'history' ? 'resolved' : 'due';
}
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
  assignedToLabel: string | null;
  /** HighLevel contact id, which is also the /customers/[contactId] route id.
   *  Null when nothing resolved, and the row then renders no customer links. */
  customerContactId: string | null;
  /** The customer's display name, or null when the contact row carries none. */
  customerName: string | null;
  /** Prebuilt HighLevel URL. Built server-side (the location id lives in the
   *  environment and this is a client component), null when unconfigured. */
  highLevelUrl: string | null;
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

/**
 * The assignee chip's text. Assignment is a LABEL and never an access
 * control (the everything-is-shared ruling): anyone can still act on a task
 * that says someone else's name, which is why the chip reads "Assigned to"
 * rather than anything possessive.
 */
export function assignedLabel(assignedToLabel: string | null): string | null {
  if (!assignedToLabel) return null;
  return assignedToLabel === 'You' ? 'Assigned to you' : `Assigned to ${assignedToLabel}`;
}

/**
 * The text of the customer link on a task row. The name when the contact
 * carries one, and a plain "View customer" when it does not: measured in
 * prod, 1 of 20 task contacts has no display name, and the link is still
 * worth offering there because /customers/[contactId] loads the contact
 * live from HighLevel and will show who it is. Never invents a name.
 */
export function customerLinkLabel(customerName: string | null): string {
  const trimmed = customerName?.trim();
  return trimmed ? trimmed : 'View customer';
}

/** Human name for a source system, used by the /tasks source filter. */
export function sourceFilterLabel(source: TaskSourceSystem): string {
  if (source === 'call_commitment') return 'From a call';
  if (source === 'quote_tool') return 'From the quote tool';
  return 'Personal';
}

/**
 * Filter + sort, pure so it can be tested without a DOM.
 *
 * Note what this deliberately does NOT do: drop a task whose source system
 * the filter has no option for. The source options are built from what the
 * loaded list actually contains (see sourceOptions below), so a future
 * source system shows up as its own option rather than vanishing from every
 * non-"all" selection.
 */
export function applyTaskViewControls(
  tasks: OfficeTask[],
  controls: { source: SourceFilter; owner: OwnerFilter; sort: SortMode },
): OfficeTask[] {
  const filtered = tasks.filter((task) => {
    if (controls.source !== 'all' && task.sourceSystem !== controls.source) return false;
    if (controls.owner !== 'all') {
      const owner = task.assignedToLabel;
      if (controls.owner === UNASSIGNED ? owner !== null : owner !== controls.owner) return false;
    }
    return true;
  });

  const time = (value: string | null) => {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  };
  // An unsortable value sinks to the bottom rather than jumping to the top,
  // in every mode — a task with a broken timestamp must never outrank a real
  // one at the head of the list.
  const rank = (task: OfficeTask): number | null => {
    if (controls.sort === 'due') return time(task.dueAt);
    if (controls.sort === 'created') return time(task.createdAt);
    return time(task.completedAt ?? task.dismissedAt);
  };
  // 'due' reads soonest-first (the working order); the other two read
  // most-recent-first.
  const direction = controls.sort === 'due' ? 1 : -1;

  return [...filtered].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (left === right) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return (left - right) * direction;
  });
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

export default function OfficeTasksCard({
  variant = 'card',
  initialView = 'active',
}: { variant?: Variant; initialView?: ViewMode } = {}) {
  const isPage = variant === 'page';
  // initialView lets /tasks?view=history open straight on History, which is
  // what the dashboard card's History link uses. The card itself never has a
  // history view, so it ignores anything but 'active'.
  const router = useRouter();
  const pathname = usePathname();
  const startingView: ViewMode = isPage ? initialView : 'active';
  const [view, setView] = useState<ViewMode>(startingView);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const [sort, setSort] = useState<SortMode>(sortDefaultFor(startingView));
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

  // Filter options are built from the LOADED LIST, not from a hard-coded
  // enumeration, so nothing a task can actually be is missing from the
  // control that is supposed to select it.
  const sourceOptions = useMemo(() => {
    const present = new Set<TaskSourceSystem>();
    for (const task of tasks ?? []) present.add(task.sourceSystem);
    return Array.from(present).sort();
  }, [tasks]);

  const ownerOptions = useMemo(() => {
    const names = new Set<string>();
    let hasUnassigned = false;
    for (const task of tasks ?? []) {
      if (task.assignedToLabel) names.add(task.assignedToLabel);
      else hasUnassigned = true;
    }
    return { names: Array.from(names).sort(), hasUnassigned };
  }, [tasks]);

  // How many active tasks are past their due time, for the page toolbar's
  // amber chip. The SAME rule the server's countActiveOfficeTasks uses for the
  // nav badge (parse due_at, ignore anything unparseable, strictly before
  // now), so the two numbers cannot disagree about what "past due" means. It
  // reads only what is already loaded, so it costs no request.
  //
  // In an effect rather than a memo on purpose: this reads the CLOCK, and a
  // memo runs during render, which react-hooks/purity forbids (a CI error
  // here, and correctly so — render must not depend on the time). The effect
  // re-runs whenever the list changes, which covers both a fresh load and a
  // task being completed in place, so the chip cannot drift from the rows
  // under it. queueMicrotask is this repo's shape for set-state-in-effect.
  const [overdueCount, setOverdueCount] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const next =
      !tasks || view !== 'active'
        ? 0
        : tasks.filter((task) => {
            const due = new Date(task.dueAt).getTime();
            return !Number.isNaN(due) && due < now;
          }).length;
    queueMicrotask(() => setOverdueCount((prev) => (prev === next ? prev : next)));
  }, [tasks, view]);

  // A selection can outlive the list it was made against: pick an assignee in
  // Open work, switch to History, and that person may not appear there. Rather
  // than RESETTING the state in an effect (a cascading render, and the
  // react-hooks/set-state-in-effect rule is a CI error here), the out-of-range
  // case is simply DERIVED back to 'all'. The select shows 'all' too, because
  // both read the same value — and switching back to a view where the option
  // exists again restores the original choice, which is the friendlier
  // behaviour of the two.
  const effectiveSource: SourceFilter =
    sourceFilter !== 'all' && !sourceOptions.includes(sourceFilter) ? 'all' : sourceFilter;
  const ownerStillPresent =
    ownerFilter === 'all' ||
    (ownerFilter === UNASSIGNED ? ownerOptions.hasUnassigned : ownerOptions.names.includes(ownerFilter));
  const effectiveOwner: OwnerFilter = ownerStillPresent ? ownerFilter : 'all';

  // The card shows the server's own due-soonest order, capped. The page
  // applies whatever the operator picked.
  const visibleTasks = useMemo(() => {
    if (!tasks) return null;
    if (!isPage) return tasks.slice(0, CARD_TASK_LIMIT);
    return applyTaskViewControls(tasks, { source: effectiveSource, owner: effectiveOwner, sort });
  }, [tasks, isPage, effectiveSource, effectiveOwner, sort]);

  // True when the operator's own filters, not an empty database, are why
  // nothing is on screen. Worth distinguishing: the fix is different.
  const hiddenByFilters = (tasks?.length ?? 0) > 0 && (visibleTasks?.length ?? 0) === 0;

  function changeView(next: ViewMode) {
    setView(next);
    // Switching tabs moves the sort to that tab's default rather than leaving
    // a mode that reads as arbitrary there.
    setSort(sortDefaultFor(next));
    // Premerge staff-lens LOW: the tabs used to change the screen and leave
    // the URL behind, so refreshing after switching away from a ?view=history
    // link snapped back to History. replace, not push, so tab clicks do not
    // pile up in the browser's back history.
    if (isPage && pathname) {
      router.replace(next === 'history' ? `${pathname}?view=history` : pathname, { scroll: false });
    }
  }

  // Premerge technical-lens MED. The nav's own "Tasks" link points at plain
  // /tasks, so clicking it FROM /tasks?view=history is a same-route client
  // transition: React keeps this component instance, useState's initial value
  // is never re-read, and the screen sat on History while the URL said
  // otherwise. The server passes a fresh initialView on every such
  // navigation, so following it here is what keeps the two honest.
  //
  // Guarded on an actual difference, which is what stops changeView's own
  // router.replace from bouncing back through here. queueMicrotask is this
  // repo's established shape for the react-hooks/set-state-in-effect rule
  // (see OperatorNav's role hint) — a CI error, not a warning.
  useEffect(() => {
    if (!isPage || initialView === view) return;
    queueMicrotask(() => {
      setView(initialView);
      setSort(sortDefaultFor(initialView));
    });
  }, [isPage, initialView, view]);

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
      // The nav badge holds its own count; tell it the list moved.
      notifyOfficeTasksChanged();
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
      notifyOfficeTasksChanged();
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

  // ONE definition, placed differently per variant. The card keeps the
  // form above its three rows, which is how the dashboard has always read.
  // The page puts it AFTER the list in the DOM and moves it into the right
  // column with grid placement, so a phone (one column, no grid placement)
  // and a screen reader both get the tasks first, which is the whole point
  // of the change. Rendering it twice would be two things to keep in step;
  // this is one.
  const addFormBlock =
    view === 'active' ? (
      <form
        className={
          isPage
            ? 'grid gap-3 self-start rounded-lg border p-3 lg:col-start-2 lg:row-start-1 lg:row-span-2'
            : 'mt-4 grid gap-3'
        }
        style={isPage ? { borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' } : undefined}
        onSubmit={createTask}
        aria-busy={creating}
      >
        {/* The panel names itself, and carries the 24-hour rule that used to
            sit under the page heading. Card keeps neither: there the section
            header above already says both. */}
        {isPage ? (
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
              Add a task
            </h3>
            <p className="mt-0.5 text-xs leading-5" style={{ color: 'var(--op-text-dim)' }}>
              Due 24 hours from now unless you choose a time.
            </p>
          </div>
        ) : null}
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
        <div className={isPage ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end'}>
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
    ) : null;

  return (
    <section
      className={isPage ? '' : 'rounded-lg border p-4 mb-8'}
      style={isPage ? undefined : { background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      aria-labelledby="office-tasks-heading"
    >
      {/* PAGE HEADER (Naldo's option A, 2026-08-29). One line: the tabs, the
          counts, and how many rows the filters are showing. The old layout
          stacked a second "Open work" heading and a paragraph of add-task
          guidance above the list; the tab already says which view this is, and
          the guidance moved into the add panel where the form actually is.
          The heading stays for screen readers, which is what names the region.
          The CARD keeps its own header untouched: on the dashboard that
          eyebrow is the only thing naming the section. */}
      {isPage ? (
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="office-tasks-heading" className="sr-only">
            {view === 'history' ? 'Completed & dismissed' : 'Open work'}
          </h2>
          <div className="flex gap-2" role="tablist" aria-label="Task list view">
            {(['active', 'history'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={view === tab}
                onClick={() => changeView(tab)}
                className="min-h-11 rounded-md border px-3 py-2 text-sm font-semibold"
                style={
                  view === tab
                    ? { borderColor: 'var(--brand-evergreen)', background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
                    : { borderColor: 'var(--op-border-mid)', color: 'var(--op-text)', background: 'var(--op-bg-raised)' }
                }
              >
                {tab === 'active' ? 'Open work' : 'History'}
              </button>
            ))}
          </div>
          {tasks !== null && loadState === 'ready' && view === 'active' ? (
            <span
              className="w-fit rounded-full px-2.5 py-1 text-xs font-medium"
              style={{ background: 'var(--brand-cream)', color: 'var(--brand-evergreen-3)' }}
            >
              {tasks.length} active
            </span>
          ) : null}
          {overdueCount > 0 ? (
            <span
              className="w-fit rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{ background: '#FBE6DF', color: '#7A2E20' }}
            >
              {overdueCount} past due
            </span>
          ) : null}
          {loadState === 'ready' && (tasks?.length ?? 0) > 0 ? (
            <p className="ml-auto text-sm" style={{ color: 'var(--op-text-dim)' }} aria-live="polite">
              Showing {visibleTasks?.length ?? 0} of {tasks?.length ?? 0}
            </p>
          ) : null}
        </div>
      ) : (
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
          </div>
        </div>
      )}

      {/* TWO COLUMNS on the page: the list owns the width, the add form is a
          panel beside it. The form comes AFTER the list in the DOM and is
          lifted into the right column by grid placement, so below the lg
          breakpoint (one column, placement inert) the tasks come first, and a
          screen reader reads them first at every width. The wrapper carries no
          classes on the card, which leaves the dashboard's stacked order
          exactly as it was. */}
      {/* A route to the add form that does not depend on scrolling past the
          list. Two premerge staff-lens MEDs share one cause: the form sits
          AFTER the list in the DOM, which is what puts the tasks first on a
          phone, and which also means that below the lg breakpoint the form is
          under the whole list, and that a keyboard user at ANY width tabs
          through every filter and every row's three buttons before reaching
          it.

          One control answers both. Below lg it is an ordinary button, sitting
          where the old form used to start, costing one row instead of the
          form's full height. At lg and above, where the panel is already on
          screen beside the list, it collapses to a skip link that only appears
          when it receives focus, so it serves the keyboard without adding
          anything for the mouse. */}
      {isPage && view === 'active' ? (
        <button
          type="button"
          onClick={() => {
            const field = document.getElementById('office-task-title');
            // No smooth behaviour on purpose: an instant jump needs no
            // prefers-reduced-motion handling.
            field?.scrollIntoView({ block: 'center' });
            field?.focus();
          }}
          className="min-h-11 w-full rounded-md border px-3 py-2 text-sm font-semibold lg:sr-only lg:focus:not-sr-only"
          style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
        >
          Add a task
        </button>
      ) : null}

      <div className={isPage ? 'mt-3 grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start' : ''}>

      {/* Filter and sort, page only. Rendered once the list is loaded, because
          every option is derived from what the list actually contains. */}
      {isPage && loadState === 'ready' && (tasks?.length ?? 0) > 0 ? (
        <div className="flex flex-wrap items-end gap-3 lg:col-start-1 lg:row-start-1">
          <div>
            <label htmlFor="office-task-source-filter" className="block text-xs font-semibold" style={{ color: 'var(--op-text-dim)' }}>
              Source
            </label>
            <select
              id="office-task-source-filter"
              value={effectiveSource}
              onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
              className="min-h-11 rounded-md border px-2 py-2 text-sm"
              style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
            >
              <option value="all">All sources</option>
              {sourceOptions.map((source) => (
                <option key={source} value={source}>
                  {sourceFilterLabel(source)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="office-task-owner-filter" className="block text-xs font-semibold" style={{ color: 'var(--op-text-dim)' }}>
              Assigned to
            </label>
            <select
              id="office-task-owner-filter"
              value={effectiveOwner}
              onChange={(event) => setOwnerFilter(event.target.value)}
              className="min-h-11 rounded-md border px-2 py-2 text-sm"
              style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
            >
              <option value="all">Anyone</option>
              {ownerOptions.names.map((name) => (
                <option key={name} value={name}>
                  {name === 'You' ? 'You' : name}
                </option>
              ))}
              {ownerOptions.hasUnassigned ? <option value={UNASSIGNED}>Nobody yet</option> : null}
            </select>
          </div>
          <div>
            <label htmlFor="office-task-sort" className="block text-xs font-semibold" style={{ color: 'var(--op-text-dim)' }}>
              Sort
            </label>
            <select
              id="office-task-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortMode)}
              className="min-h-11 rounded-md border px-2 py-2 text-sm"
              style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
            >
              {view === 'history' ? <option value="resolved">Recently finished</option> : null}
              <option value="due">Due soonest</option>
              <option value="created">Recently added</option>
            </select>
          </div>
        </div>
      ) : null}

      {!isPage ? addFormBlock : null}

      <div className={isPage ? 'lg:col-start-1 lg:row-start-2' : ''}>
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
      ) : hiddenByFilters ? (
        <div className="mt-4 rounded-md p-3 text-sm" style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}>
          <p>
            No tasks match these filters. There {tasks?.length === 1 ? 'is 1 task' : `are ${tasks?.length ?? 0} tasks`}{' '}
            in this view.
          </p>
          {/* Premerge staff-lens LOW: clearing two dropdowns separately to get
              back to a list is busywork, and the empty screen is exactly where
              someone needs the way out. */}
          <button
            type="button"
            onClick={() => {
              setSourceFilter('all');
              setOwnerFilter('all');
            }}
            className="mt-2 min-h-11 rounded-md border px-3 py-2 font-semibold"
            style={{ borderColor: 'var(--op-border-mid)', background: 'var(--op-bg-raised)', color: 'var(--op-text)' }}
          >
            Clear filters
          </button>
        </div>
      ) : tasks?.length === 0 ? (
        <p className="mt-4 rounded-md p-3 text-sm" style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}>
          {view === 'history' ? 'No completed or dismissed tasks yet.' : 'No open or blocked tasks. New tasks will appear here.'}
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {visibleTasks?.map((task) => {
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
                      {assignedLabel(task.assignedToLabel) ? (
                        <span
                          className="rounded-full px-2 py-0.5 text-xs font-semibold"
                          style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}
                          title="A label, not a lock. Anyone can still work this task."
                        >
                          {assignedLabel(task.assignedToLabel)}
                        </span>
                      ) : null}
                    </div>
                    {task.customerContactId ? (
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <Link
                          href={`/customers/${encodeURIComponent(task.customerContactId)}`}
                          className="font-medium hover:underline"
                          style={{ color: 'var(--op-primary)' }}
                        >
                          {customerLinkLabel(task.customerName)}
                        </Link>
                        {task.highLevelUrl ? (
                          <a
                            href={task.highLevelUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs hover:underline"
                            style={{ color: 'var(--op-text-dim)' }}
                          >
                            HighLevel
                          </a>
                        ) : null}
                      </p>
                    ) : null}
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

      </div>

      {isPage ? addFormBlock : null}
      </div>

      {/* The card's way out to everything it does not show: history, the
          rest of the list, and the filters. Rendered whatever the load state,
          so a failed fetch on the dashboard still leaves a route to the page. */}
      {!isPage ? (
        <p className="mt-4 text-sm">
          <Link href="/tasks" className="font-semibold underline" style={{ color: 'var(--brand-evergreen-3)' }}>
            See all tasks
          </Link>
          {(tasks?.length ?? 0) > CARD_TASK_LIMIT ? (
            <span style={{ color: 'var(--op-text-dim)' }}> ({(tasks?.length ?? 0) - CARD_TASK_LIMIT} more not shown)</span>
          ) : null}
          {/* Premerge staff-lens MED, Naldo's call 2026-08-29: slimming the
              card moved "what did we already finish" from one click to two
              plus a page load. This link puts it back at one, landing on the
              History tab directly rather than on the page's default view. */}
          <span style={{ color: 'var(--op-text-dim)' }}> &middot; </span>
          <Link
            href="/tasks?view=history"
            className="font-semibold underline"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            History
          </Link>
        </p>
      ) : null}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
