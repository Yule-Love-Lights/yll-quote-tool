// A one-line channel between the two copies of the time clock.
//
// Jason asked to keep the dashboard clock after the header one shipped
// (2026-09-01), so on the dashboard BOTH are on screen at once. Each fetches
// its own state on mount, so without this they disagree the moment either one
// is used: clock out in the header and the dashboard card still reads "In
// since 7:22" until the page is reloaded. Two controls showing different
// answers about whether someone is on the clock is worse than either control
// alone, because now you have to guess which one is right.
//
// A window event, for the same reason officeTasksEvents.ts uses one: the nav
// is rendered by OperatorShell above every page's content, so the header clock
// and the dashboard clock have no common provider to hang state from.
//
// Every clock re-reads the SERVER after the signal rather than copying the
// payload from whichever one acted. That keeps the existing rule that the card
// never renders an optimistic guess about what a tap did.

export const CLOCK_CHANGED = 'office-clock-changed';

/** Tell every other clock on the page that the shift state moved. No-op on the server. */
export function notifyClockChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CLOCK_CHANGED));
}
