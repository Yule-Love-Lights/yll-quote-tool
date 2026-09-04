// The time-exception queue's UI (ops hub workstream A; the classifier and
// API shipped in row 278 with no surface). Pure presentational and
// server-renderable: /admin/time-tracking loads the data and passes it in.
//
// READ-ONLY on purpose, matching the module it renders: opsTimeExceptions
// reports and closes nothing, because manual punches are authoritative for
// pay and a human decides what actually happened.

import { Card, EmptyState, ErrorNote, Pill } from '@/components/time/timeUi';
import type { TimeException, TimeExceptionType } from '@/lib/opsTimeExceptions';

const LABELS: Record<TimeExceptionType, string> = {
  forgotten_clock_out: 'Forgotten clock-out',
  open_break_on_closed_shift: 'Break left open',
  open_segment_on_closed_shift: 'Job segment left open',
  stale_open_segment: 'Possible missed tap',
};

export function timeExceptionLabel(type: TimeExceptionType): string {
  return LABELS[type];
}

// ET regardless of the server's own timezone: prod renders on a UTC box, and
// a raw toLocaleString there would print times seven hours off the crew's day.
const fmtEt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'short',
    timeStyle: 'short',
  });

export function TimeExceptionsSection({
  exceptions,
  crewNames,
  errors,
}: {
  exceptions: TimeException[];
  /** crewMemberId to display name; misses fall back to a short id (an
      exception can belong to a since-deactivated crew member). */
  crewNames: Map<string, string>;
  errors: string[];
}) {
  return (
    <Card
      title="Time exceptions"
      // The "look at those first" sentence stays VISIBLE, not in the
      // disclosure: it exists because of an earlier admin-lens HIGH, and two
      // lenses on PR #1218 independently flagged it going behind a click.
      // Every exception type wears the same amber pill, so this sentence is
      // the only thing that ranks them.
      subtitle="Stuck time records that need a human: a shift, break, or job segment left open that no automatic path will close. A possible missed tap can corrupt job time and pay while the day is still live, so look at those first."
      helpLabel="What these mean, and how to fix one"
      help={
        <>
          {/* Copy scoped per class (admin-lens HIGH on this PR): the module
              header's "neither corrupts pay" covers only the two ORPHAN
              classes (open rows under a closed shift clip to the recorded
              clock-out). A possible missed Depart tap is different: the
              classifier's own detail calls it the one un-backstopped
              pay-and-data corruption path, so the copy must not claim
              blanket pay safety. */}
          <p>
            Rows left open under an already-closed shift only lie about what happened (pay clips
            to the recorded clock-out). A possible missed tap is the exception: a forgotten Depart
            can corrupt job time and pay data while the day is still live, so look at those first.
          </p>
          {/* The fix path (admin lens on the digest PR: a queue with no
              repair door nags forever). It names the person's own hours
              page, which serves office and field alike; the two clocks page
              is offered as the second door because it puts the GPS timeline
              beside the shift, and it lists FIELD shifts only (fleetDay.ts).
              An earlier version of this comment said office shifts had no
              editor at all — true until the person page shipped, false the
              moment it did. */}
          <p>
            To fix one, open the person&apos;s name in the hours table above and correct the
            shift&apos;s times; closing the shift there closes its stuck children. Field crew
            shifts can also be corrected beside the GPS timeline on{' '}
            <a href="/admin/fleet/clocks" className="underline">
              the day&apos;s two clocks page
            </a>
            , which lists field shifts only.
          </p>
        </>
      }
      flush
    >
      {errors.length > 0 && (
        <div className="p-4 sm:p-5">
          <ErrorNote items={errors} />
        </div>
      )}

      {errors.length === 0 && exceptions.length === 0 && (
        <div className="p-4 sm:p-5">
          <EmptyState>No open time exceptions.</EmptyState>
        </div>
      )}

      {exceptions.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {exceptions.map((ex) => (
            <li
              key={`${ex.type}-${ex.shiftId}-${ex.rowId ?? 'shift'}`}
              className="px-4 py-3 sm:px-5"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-gray-900">
                  {crewNames.get(ex.crewMemberId) ?? ex.crewMemberId.slice(0, 8)}
                </span>
                <Pill tone="amber" nowrap>
                  {timeExceptionLabel(ex.type)}
                </Pill>
                <span className="text-xs text-gray-400">open since {fmtEt(ex.openedAt)} ET</span>
              </div>
              <p className="mt-1 text-sm text-gray-600">{ex.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
