// The staff self-view's own hours — time-tracking plan phase 4.
//
// The admin record (PersonHoursSections.tsx) and this share ONE row renderer
// (HoursDayList) and nothing else, on purpose. They are read by different
// people about the same rows and the voice has to differ: the admin page says
// "ask them what time they stopped", this one is talking TO the person who
// stopped.
//
// NO CONTROLS AND NO MONEY. `controls="none"` means the edit, remove and
// paid-lock markup is not rendered at all rather than hidden, and the page
// that mounts this never reads settlements (loadPersonTime's
// `withSettlements: false`), so no pay figure exists on this screen to leak.
// The copy below says both of those out loud: a screen that silently offers
// no way to fix a wrong time reads as broken unless it says where to go.

import Link from 'next/link';

import { HoursDayList, fmtTime, sourceLabel } from '@/components/time/HoursDayList';
import { formatHours } from '@/lib/hoursSummary';
import { RANGE_KEYS, rangeLabel, type PersonDay, type RangeKey } from '@/lib/personHours';

export function MyHoursSection({
  days,
  range,
  totalSeconds,
  shiftCount,
  autoClosed,
  openShift,
  errors,
  basePath,
}: {
  days: PersonDay[];
  range: RangeKey;
  totalSeconds: number;
  shiftCount: number;
  autoClosed: { count: number; seconds: number };
  openShift: { clockInAt: string; source: string } | null;
  errors: string[];
  /** The page's own path, for the range links. */
  basePath: string;
}) {
  return (
    <section className="mb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 className="text-lg font-semibold text-gray-900">Hours</h2>
        <nav className="flex flex-wrap gap-1 text-xs">
          {RANGE_KEYS.map((key) => (
            <Link
              key={key}
              href={`${basePath}?range=${key}`}
              aria-current={key === range ? 'page' : undefined}
              className={
                key === range
                  ? 'rounded-full bg-gray-900 px-3 py-1 font-medium text-white'
                  : 'rounded-full border border-gray-300 px-3 py-1 text-gray-600'
              }
            >
              {rangeLabel(key)}
            </Link>
          ))}
        </nav>
      </div>

      <p className="text-sm text-gray-500 mb-4">
        Your clocked time, day by day. A shift counts on the day it started (New York time), so a
        shift that ran past midnight shows in full on the day it began. This is a record of hours,
        not a payslip: it does not say what you have been paid.
      </p>

      {errors.length > 0 && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-medium">Some of your record could not be read, so it is incomplete.</p>
          <ul className="list-disc pl-5 mt-1">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
        <span className="text-sm text-gray-700">
          <span className="font-semibold tabular-nums">{formatHours(totalSeconds)}</span> over{' '}
          {rangeLabel(range).toLowerCase()}
        </span>
        <span className="text-sm text-gray-500 tabular-nums">
          {shiftCount} {shiftCount === 1 ? 'shift' : 'shifts'}
        </span>
        {openShift && (
          <span className="text-sm text-green-800">
            Clocked in since {fmtTime(openShift.clockInAt)} ({sourceLabel(openShift.source)}), still
            counting
          </span>
        )}
        {/* Same fact as the admin page's amber count, said to the person it
            happened to. 5 of 27 real shifts were closed this way, so this is
            an everyday state, not an edge case. */}
        {autoClosed.count > 0 && (
          <span className="text-sm text-amber-800">
            {autoClosed.count} closed by the midnight sweep, {formatHours(autoClosed.seconds)} of
            this total — tell the office what time you really stopped
          </span>
        )}
      </div>

      {days.length === 0 ? (
        <p className="text-sm text-gray-500">No shifts in this range.</p>
      ) : (
        // Field crew have no second record of their own to send them to, and
        // the admin page's evidence link points at /admin/fleet/clocks, which
        // redirects anyone who is not an admin. Never offered here.
        <HoursDayList days={days} crewName="you" controls="none" evidenceFor={() => null} />
      )}

      <p className="text-xs text-gray-500 mt-4">
        Something wrong? Ask the office to correct it — a time can only be changed by an admin, and
        the change is recorded against your shift with their name on it.
      </p>
    </section>
  );
}
