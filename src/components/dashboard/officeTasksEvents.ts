// A one-line channel between the Office Tasks list and the nav badge.
//
// The badge (OperatorNav) fetches its count once per page mount. The list
// (OfficeTasksCard) mutates tasks without navigating, so without this the two
// disagree: a staffer completes the last overdue task on the dashboard, the
// card updates, and the nav pill stays red with a stale number until they
// happen to load another page. Found by the premerge staff lens.
//
// A window event rather than shared React state on purpose: the nav is
// rendered by OperatorShell above every page's content, so the two components
// have no common provider to hang state from, and adding one would mean
// touching all 50-plus pages that mount the shell. This module is deliberately
// tiny and importable by both, so the nav never has to import the card.

export const OFFICE_TASKS_CHANGED = 'office-tasks-changed';

/** Tell any listening badge that the task list moved. No-op on the server. */
export function notifyOfficeTasksChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OFFICE_TASKS_CHANGED));
}
