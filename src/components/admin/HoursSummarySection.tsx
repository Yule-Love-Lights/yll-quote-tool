// The per-person hours table on /admin/time-tracking (time-tracking plan
// phase 1). Pure presentational and server-renderable: the page loads
// `loadHoursSummary` and passes the result in.
//
// HOURS ONLY, by design. No rate, no money, no approve button. The rows it
// renders carry no rate field at all, so a later edit here cannot multiply
// anything by anything without first changing the data module.

import { formatHours, type PersonHours } from '@/lib/hoursSummary';

// ET regardless of the server's own timezone (prod renders on a UTC box).
const fmtEtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });

const fmtEtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'short',
    timeStyle: 'short',
  });

const SOURCE_LABEL: Record<string, string> = {
  office: 'web clock',
  telegram: 'Telegram',
  pwa: 'crew app',
  system: 'system',
};

export function HoursSummarySection({
  rows,
  asOf,
  errors,
}: {
  rows: PersonHours[];
  asOf: string;
  errors: string[];
}) {
  const anyAutoClosed = rows.some((r) => r.autoClosed.count > 0);
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Hours</h2>
      {/* "Clocked", not "paid" (admin lens on PR #1176): nothing on this
          page is approved or paid, and the lead sentence is the one an
          owner reads before the numbers. */}
      <p className="text-sm text-gray-500 mb-2">
        Clocked time: clock-in to clock-out, minus breaks. Nothing here is approved or paid. A
        shift counts on the day it started (New York time), and someone still clocked in counts
        up to now. Rolling windows, today included.
      </p>
      {/* The fix path has to name a door that EXISTS for the row it is next
          to (AGENTS.md: a guard and the copy that narrates it are one change).
          The only shift editor today is the two clocks page, and fleetDay.ts
          shows FIELD shifts only (Naldo, 2026-08-28: "field group only"), so
          an office person's auto-close cannot be reached from it. Say so,
          rather than send the admin to a page that will not list the row.
          Phase 2 of the time-tracking plan is the first editor for those. */}
      <p className="text-sm text-gray-500 mb-4">
        A day nobody clocked out of is closed at midnight by the system. Those rows are counted
        here and flagged, because the figure is wrong until a human corrects the shift. Field
        crew shifts are corrected on{' '}
        <a href="/admin/fleet/clocks" className="underline">
          the day&apos;s two clocks page
        </a>
        ; office shifts have no editor in the app yet, so an office auto-close stays flagged until
        one is built.
      </p>

      {errors.length > 0 && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-medium">Some hours could not be read, so the table below is incomplete.</p>
          <ul className="list-disc pl-5 mt-1">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No staff rows to show.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium text-right">Today</th>
                <th className="px-3 py-2 font-medium text-right">Last 7 days</th>
                <th className="px-3 py-2 font-medium text-right">Last 30 days</th>
                <th className="px-3 py-2 font-medium text-right">All time</th>
                <th className="px-3 py-2 font-medium text-right">Shifts</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.crewMemberId} className={r.active ? '' : 'text-gray-400'}>
                  <td className="px-3 py-2 font-medium whitespace-nowrap">
                    {r.displayName}
                    {!r.active && <span className="ml-2 text-xs font-normal">(inactive)</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.isOffice ? 'Office' : 'Field'}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatHours(r.todaySeconds)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatHours(r.last7Seconds)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatHours(r.last30Seconds)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {formatHours(r.allTimeSeconds)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.shiftCount}</td>
                  <td className="px-3 py-2">
                    {r.openShift && (
                      <span className="inline-block rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800 whitespace-nowrap">
                        Clocked in since {fmtEtTime(r.openShift.clockInAt)} (
                        {SOURCE_LABEL[r.openShift.source] ?? r.openShift.source})
                      </span>
                    )}
                    {r.autoClosed.count > 0 && (
                      <span
                        className={`inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 whitespace-nowrap${r.openShift ? ' ml-1' : ''}`}
                      >
                        {r.autoClosed.count} auto-closed at midnight, {formatHours(r.autoClosed.seconds)}{' '}
                        inside All time
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-xs text-gray-400">
        As of {fmtEtDateTime(asOf)} ET.
        {anyAutoClosed
          ? ' Amber rows include hours the system closed at midnight; nothing here is approved or paid, and those totals are wrong until the shifts are corrected.'
          : ''}
      </p>
    </section>
  );
}
