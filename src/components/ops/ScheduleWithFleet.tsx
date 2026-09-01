'use client';

// The Schedule page's two-column layout (Naldo, 2026-08-31): the schedule on
// the left, the fleet view on the right.
//
// The fleet column shows ONLY when the day picker is on today. The map is
// always live, so pairing it with next Tuesday's jobs would put this minute's
// van positions under a future day's heading. On any other day the column
// says where the vans went rather than vanishing, so the layout does not
// silently change shape and leave someone wondering what they broke.
//
// Deliberately thin. Naldo's note, 2026-08-31: scheduling is not finished and
// Jason redesigns this page later, so this holds the date and places two
// nodes and does nothing else. The fleet column arrives already rendered as a
// prop from the server component, so no fleet data is fetched in the browser.

import { useState } from 'react';

import { ScheduleDay } from './ScheduleDay';

type CrewMember = { id: string; displayName: string; active: boolean };

/**
 * Whether the fleet column belongs beside the day on screen. PURE, and lifted
 * out of the component on purpose: the not-today branch is unreachable in a
 * static render (the picker's date is client state), so inline it was a branch
 * no test could fail on. The AGENTS.md rule about lifting logic out of an
 * untestable screen, applied to four lines.
 *
 * Both arguments are ET day keys, and BOTH come from the server for the first
 * paint. Comparing against a freshly computed browser clock is what produced
 * the ET-midnight disagreement the premerge staff lens found.
 */
export function shouldShowFleet(date: string, todayKey: string): boolean {
  return date === todayKey;
}

export function ScheduleWithFleet({
  crew,
  fleet,
  todayKey,
}: {
  crew: CrewMember[];
  /** The server-rendered fleet view. Rendered here, fetched on the server. */
  fleet: React.ReactNode;
  /**
   * Today in the ET business day, computed on the server so the first paint
   * matches what ScheduleDay itself starts on. ScheduleDay's own default uses
   * the same etDayKey clock.
   */
  todayKey: string;
}) {
  const [date, setDate] = useState(todayKey);
  // ONE clock, the server's, shared with ScheduleDay via initialDate below.
  // This used to compare against a freshly computed browser value, which meant
  // a page rendered just before ET midnight and hydrated just after could show
  // today's jobs beside a fleet column claiming this is not today (premerge
  // staff lens, 2026-08-31). Both components now start from the same string,
  // and only the day picker moves it.
  const isToday = shouldShowFleet(date, todayKey);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <ScheduleDay crew={crew} onDateChange={setDate} initialDate={todayKey} />
      </div>
      <aside className="min-w-0">
        {isToday ? (
          fleet
        ) : (
          <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
            <strong className="text-gray-800">The vans are hidden on other days.</strong> Their
            positions are always live, so they would tell you where the fleet is right now, not
            where it was on {date}. Come back to today to see them.
          </p>
        )}
      </aside>
    </div>
  );
}
