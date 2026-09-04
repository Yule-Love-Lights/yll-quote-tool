// The staff self-view's own hours — time-tracking plan phase 4.
//
// The admin record (PersonHoursSections.tsx) and this share ONE row renderer
// (HoursDayList) and nothing else, on purpose. They are read by different
// people about the same rows and the voice has to differ: the admin page says
// "ask them what time they stopped", this one is talking TO the person who
// stopped.
//
// NO CONTROLS. `controls="none"` means the edit, remove and paid-lock markup
// is not rendered at all rather than hidden. The copy says so out loud: a
// screen that silently offers no way to fix a wrong time reads as broken
// unless it names where the fix lives.
//
// PAYMENT STATE, NEVER AN AMOUNT. It does show which hours have been paid for
// and which have not (Jason, 2026-09-03), because that is what tells someone
// what is still outstanding. It is HOURS on both sides of that split: the
// office records what was actually paid rather than computing it, and with
// overtime unruled (ledger row 285) a figure here would be one nobody has
// agreed. No rate and no cents value reaches this component.
//
// And when the settlement read FAILED, this page says nothing about payment
// at all rather than falling back to "unpaid" — telling someone they are owed
// for hours already paid is the wrong way to be wrong.

import { HoursDayList, fmtTime, sourceLabel } from '@/components/time/HoursDayList';
import {
  Card,
  EmptyState,
  ErrorNote,
  RangeTabs,
  StatStrip,
  StatTile,
  WarnNote,
} from '@/components/time/timeUi';
import { formatHours } from '@/lib/hoursSummary';
import { rangeLabel, splitPaidHours, type PersonDay, type RangeKey } from '@/lib/personHours';

export function MyHoursSection({
  days,
  range,
  totalSeconds,
  shiftCount,
  autoClosed,
  openShift,
  errors,
  basePath,
  settlementsReadable,
}: {
  days: PersonDay[];
  /** False when the settlement read FAILED. Then this page says NOTHING about
   * payment: no markers, no unpaid total, just a line saying it could not be
   * read. Falling back to "unpaid" would tell someone they are owed for hours
   * they have already been paid for. */
  settlementsReadable: boolean;
  range: RangeKey;
  totalSeconds: number;
  shiftCount: number;
  autoClosed: { count: number; seconds: number };
  openShift: { clockInAt: string; source: string } | null;
  errors: string[];
  /** The page's own path, for the range links. */
  basePath: string;
}) {
  const split = splitPaidHours(days);
  // The summary's own copy of the row-level fix: a shift the office has since
  // typed over keeps close_source 'system' forever, so the amber line kept
  // telling the person to report a time that had already been corrected.
  // `autoClosed` counts every swept shift (the admin page needs that); only
  // the CALL TO ACTION is conditional on one still being uncorrected.
  const uncorrectedSweeps = days
    .flatMap((d) => d.shifts)
    .filter((s) => s.closeSource === 'system' && s.manualBy === null).length;
  const notices = errors.length > 0 || openShift !== null || autoClosed.count > 0;
  const showPaidSplit = days.length > 0 && settlementsReadable;

  return (
    <>
      {/* What has been paid for and what has not (Jason, 2026-09-03), in
          HOURS. Never a figure: the tool records payments and does not work
          them out, overtime has no agreed formula (ledger row 285), and a
          real week in this data is 50h 55m — so "12h nobody has paid you for
          yet" is true where "you are owed $X" would be invented. */}
      <StatStrip>
        <StatTile
          label="Hours"
          value={formatHours(totalSeconds)}
          sub={`${shiftCount} ${shiftCount === 1 ? 'shift' : 'shifts'} · ${rangeLabel(range).toLowerCase()}`}
        />
        {showPaidSplit && (
          <>
            <StatTile
              label="Hours not paid yet"
              value={formatHours(split.unpaidSeconds)}
              tone={split.unpaidSeconds > 0 ? 'warn' : 'muted'}
              sub={
                split.unpaidCount > 0
                  ? `${split.unpaidCount} ${split.unpaidCount === 1 ? 'shift' : 'shifts'} in this range`
                  : 'nothing outstanding in this range'
              }
            />
            <StatTile
              label="Hours already paid"
              value={formatHours(split.paidSeconds)}
              tone="good"
              sub="in this range"
            />
          </>
        )}
      </StatStrip>

      {/* Time still running is in neither total. Calling a shift you are
          standing in "unpaid" invites it to be expected in this week's
          payment. */}
      {showPaidSplit && split.openSeconds > 0 && (
        <p className="-mt-3 mb-6 text-xs" style={{ color: 'var(--op-text-dim)' }}>
          The shift you are in now is counted in neither.
        </p>
      )}

      {days.length > 0 && !settlementsReadable && (
        <div className="mb-6">
          <WarnNote>
            Which of these hours have already been paid could not be read just now, so nothing
            below is marked either way. The hours themselves are correct.
          </WarnNote>
        </div>
      )}

      <Card
        title="Shifts"
        subtitle="Your clocked time, day by day. This is a record of hours, not a payslip: it does not say what you have been paid."
        aside={<RangeTabs basePath={basePath} range={range} />}
        help={
          <p>
            A shift counts on the day it started (New York time), so a shift that ran past midnight
            shows in full on the day it began.
          </p>
        }
        flush
      >
        {notices && (
          <div className="space-y-2 px-4 py-4 sm:px-5">
            {errors.length > 0 && (
              <ErrorNote
                title="Some of your record could not be read, so it is incomplete."
                items={errors}
              />
            )}
            {openShift && (
              <p className="text-sm text-green-800">
                Clocked in since {fmtTime(openShift.clockInAt)} ({sourceLabel(openShift.source)}),
                still counting
              </p>
            )}
            {/* Same fact as the admin page's amber count, said to the person
                it happened to. 5 of 27 real shifts were closed this way, so
                this is an everyday state, not an edge case. */}
            {autoClosed.count > 0 && (
              <WarnNote>
                {autoClosed.count} closed by the midnight sweep, {formatHours(autoClosed.seconds)}{' '}
                of this total
                {uncorrectedSweeps > 0 ? ' — tell the office what time you really stopped' : ''}
              </WarnNote>
            )}
          </div>
        )}

        {days.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>No shifts in this range.</EmptyState>
          </div>
        ) : (
          // Field crew have no second record of their own to send them to, and
          // the admin page's evidence link points at /admin/fleet/clocks, which
          // redirects anyone who is not an admin. Never offered here.
          <HoursDayList
            days={days}
            crewName="you"
            controls="none"
            evidenceFor={() => null}
            // A failed settlement read must not read as "none of these are
            // paid": the markers come off entirely.
            showPaidMarks={settlementsReadable}
          />
        )}
      </Card>

      {days.length > 0 && settlementsReadable && (
        <p className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          A shift marked <span className="font-medium text-gray-700">Paid</span> is one the office
          has recorded a payment against. Anything unmarked has not been paid yet. This page does
          not work out what you are owed — the office records what was actually paid, which is not
          always hours times a rate.
        </p>
      )}

      <p className="mt-3 text-xs" style={{ color: 'var(--op-text-dim)' }}>
        Something wrong? Ask the office to correct it — a time can only be changed by an admin, and
        the change is recorded against your shift with their name on it.
      </p>
    </>
  );
}
