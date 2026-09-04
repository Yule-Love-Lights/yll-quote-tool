/**
 * PURE view helpers for the Schedule page. No IO, and deliberately NOT in
 * scheduling.ts: that module imports the Supabase SERVICE client at its top, so
 * importing it from a 'use client' component would drag server-only code into
 * the browser bundle. tsc does not catch that, which is why this file exists.
 */

/**
 * The slice of the unscheduled list a page shows, and how many it is hiding.
 *
 * The old render did `slice(0, 25)` inline under a heading showing the FULL
 * count, so "Not scheduled yet (43)" sat above 25 rows and the other 18 were
 * invisible with nothing saying so. Naldo hit exactly that with job #1069 at
 * position 41 of 43 (2026-09-04).
 */
export function visibleUnscheduled<T>(jobs: readonly T[], cap: number): { shown: T[]; hidden: number } {
  // A non-finite cap would slice to nothing while the note claimed a count, so
  // clamp it to something real first (technical lens).
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  const shown = jobs.slice(0, limit);
  return { shown, hidden: Math.max(0, jobs.length - shown.length) };
}

/**
 * One row of the "Not scheduled yet" list, as the page needs it. Declared in
 * this PURE module so a client component can type its state without importing
 * scheduling.ts, which pulls in the Supabase service client.
 */
export type UnscheduledRow = {
  jobId: string;
  jobNumber: number | null;
  status: string;
  budgetedHours: number | null;
  hoursArePlaceholder: boolean;
  customerName: string | null;
  address: string | null;
};
