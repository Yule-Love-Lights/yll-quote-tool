// The per-person hours table on /admin/time-tracking (time-tracking plan
// phase 1). Pure presentational and server-renderable: the page loads
// `loadHoursSummary` and passes the result in.
//
// HOURS ONLY, by design. No rate, no money, no approve button. The rows it
// renders carry no rate field at all, so a later edit here cannot multiply
// anything by anything without first changing the data module.

import Link from 'next/link';

import { Card, EmptyState, ErrorNote, Pill } from '@/components/time/timeUi';
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

const TH = 'px-4 py-2.5 font-semibold sm:px-5';
const TD = 'px-4 py-3 whitespace-nowrap sm:px-5';

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
    <Card
      title="Hours"
      // "Clocked", not "paid" (admin lens on PR #1176): nothing on this page
      // is approved or paid, and this is the sentence an owner reads before
      // the numbers, so it stays in the header rather than in the help.
      subtitle="Clocked time: clock-in to clock-out, minus breaks. Nothing here is approved or paid."
      help={
        <>
          <p>
            A shift counts on the day it started (New York time), and someone still clocked in
            counts up to now. Rolling windows, today included.
          </p>
          {/* The fix path has to name a door that EXISTS for the row it is
              next to (AGENTS.md: a guard and the copy that narrates it are
              one change). As of phase 2 that door is the person's own page,
              reached by their name below, and it works for office and field
              alike — the two clocks page still shows field shifts only
              (fleetDay.ts). */}
          <p>
            A day nobody clocked out of is closed at midnight by the system. Those rows are
            counted here and flagged, because the figure is wrong until a human corrects the
            shift. Open someone&apos;s name to see their shifts day by day and correct the times;
            field crew shifts can also be corrected beside the GPS timeline on{' '}
            <a href="/admin/fleet/clocks" className="underline">
              the day&apos;s two clocks page
            </a>
            .
          </p>
        </>
      }
      flush
      footer={
        <p className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          As of {fmtEtDateTime(asOf)} ET.
          {anyAutoClosed
            ? ' Amber rows include hours the system closed at midnight; nothing here is approved or paid, and those totals are wrong until the shifts are corrected.'
            : ''}
        </p>
      }
    >
      {errors.length > 0 && (
        <div className="px-4 pt-4 sm:px-5">
          <ErrorNote
            title="Some hours could not be read, so the table below is incomplete."
            items={errors}
          />
        </div>
      )}

      {rows.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState>No staff rows to show.</EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead
              className="text-left text-[11px] uppercase tracking-wide"
              style={{ background: 'var(--op-bg)', color: 'var(--op-text-dim)' }}
            >
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Type</th>
                <th className={`${TH} text-right`}>Today</th>
                <th className={`${TH} text-right`}>Last 7 days</th>
                <th className={`${TH} text-right`}>Last 30 days</th>
                <th className={`${TH} text-right`}>All time</th>
                <th className={`${TH} text-right`}>Shifts</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.crewMemberId} className={r.active ? '' : 'opacity-50'}>
                  <td className={`${TD} font-semibold`}>
                    {/* The name is the door to the person's own record (phase
                        2). A '(unknown)' row links too: its id is a real crew
                        id off a shift whose staff row is missing, and the
                        detail page says exactly that instead of leaving a
                        dead-end row nobody can investigate. */}
                    <Link
                      href={`/admin/time-tracking/${encodeURIComponent(r.crewMemberId)}`}
                      className="hover:underline"
                      style={{ color: 'var(--op-text)' }}
                    >
                      {r.displayName}
                    </Link>
                    {!r.active && <span className="ml-2 text-xs font-normal">(inactive)</span>}
                  </td>
                  <td className={TD}>
                    <Pill tone={r.isOffice ? 'gold' : 'neutral'} nowrap>
                      {r.isOffice ? 'Office' : 'Field'}
                    </Pill>
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{formatHours(r.todaySeconds)}</td>
                  <td className={`${TD} text-right tabular-nums`}>{formatHours(r.last7Seconds)}</td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {formatHours(r.last30Seconds)}
                  </td>
                  <td className={`${TD} text-right tabular-nums font-semibold`}>
                    {formatHours(r.allTimeSeconds)}
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{r.shiftCount}</td>
                  <td className={`${TD} whitespace-normal`}>
                    <div className="flex flex-wrap gap-1">
                      {r.openShift && (
                        <Pill tone="green" nowrap>
                          Clocked in since {fmtEtTime(r.openShift.clockInAt)} (
                          {SOURCE_LABEL[r.openShift.source] ?? r.openShift.source})
                        </Pill>
                      )}
                      {r.autoClosed.count > 0 && (
                        <Pill tone="amber" nowrap>
                          {r.autoClosed.count} auto-closed at midnight,{' '}
                          {formatHours(r.autoClosed.seconds)} inside All time
                        </Pill>
                      )}
                      {!r.openShift && r.autoClosed.count === 0 && (
                        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
                          —
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
