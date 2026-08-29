// The time-exception queue's UI (ops hub workstream A; the classifier and
// API shipped in row 278 with no surface). Pure presentational and
// server-renderable: /admin/time-tracking loads the data and passes it in.
//
// READ-ONLY on purpose, matching the module it renders: opsTimeExceptions
// reports and closes nothing, because manual punches are authoritative for
// pay and a human decides what actually happened.

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
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Time exceptions</h2>
      <p className="text-sm text-gray-500 mb-4">
        Stuck time records that need a human: a shift, break, or job segment left open that no
        automatic path will ever close. Pay is not corrupted by these (open rows clip to the
        recorded clock-out), but until someone looks, the record lies about what happened.
      </p>

      {errors.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}

      {errors.length === 0 && exceptions.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-sm text-gray-500">No open time exceptions.</p>
        </div>
      )}

      {exceptions.length > 0 && (
        <ul className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {exceptions.map((ex) => (
            <li key={`${ex.type}-${ex.shiftId}-${ex.rowId ?? 'shift'}`} className="p-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-gray-900">
                  {crewNames.get(ex.crewMemberId) ?? ex.crewMemberId.slice(0, 8)}
                </span>
                <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                  {timeExceptionLabel(ex.type)}
                </span>
                <span className="text-xs text-gray-400">open since {fmtEt(ex.openedAt)} ET</span>
              </div>
              <p className="text-sm text-gray-600 mt-1">{ex.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
