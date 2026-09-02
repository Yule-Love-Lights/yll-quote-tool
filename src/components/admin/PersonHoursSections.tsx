// One person's day-by-day hours and their manual-write trail, for
// /admin/time-tracking/[crewMemberId] (time-tracking plan phase 2).
//
// Server-renderable and presentational; the page loads `loadPersonTime` and
// passes the result in. The only interactive parts are the existing
// ManualShiftEditor client controls, which are the SAME components the two
// clocks page uses — one editor, not a second one that could drift from it.
//
// HOURS ONLY, like phase 1: no rate, no money, no approval control.

import Link from 'next/link';

import { EditShiftTimes, VoidShiftButton } from '@/components/admin/ManualShiftEditor';
import { formatHours } from '@/lib/hoursSummary';
import {
  RANGE_KEYS,
  rangeLabel,
  type PersonDay,
  type PersonShift,
  type RangeKey,
  type ShiftAuditEntry,
} from '@/lib/personHours';

// ET regardless of the server's own timezone: prod renders on a UTC box.
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/** A YYYY-MM-DD ET day key as a heading. Built from the parts rather than
 * `new Date(key)`, which would parse as UTC midnight and print the previous
 * day for anyone reading east of Greenwich. */
function fmtDayKey(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Date unknown';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(
    'en-US',
    { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' },
  );
}

const SOURCE_LABEL: Record<string, string> = {
  office: 'web clock',
  telegram: 'Telegram',
  pwa: 'crew app',
  system: 'system',
};

const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

function ShiftRow({
  shift,
  crewName,
  evidenceHref,
}: {
  shift: PersonShift;
  crewName: string;
  /** Where the admin can SEE what really happened that day, or null when
      nothing in the app knows. A badge saying "correct it" with no evidence
      to correct it from invites a confident guess typed into payroll (admin
      lens on PR #1178). */
  evidenceHref: string | null;
}) {
  const open = shift.clockOutAt === null;
  const autoClosed = shift.closeSource === 'system';
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-gray-900 tabular-nums whitespace-nowrap">
          {fmtTime(shift.clockInAt)} – {open ? 'still open' : fmtTime(shift.clockOutAt as string)}
        </span>
        <span className="text-sm tabular-nums text-gray-700 whitespace-nowrap">
          {formatHours(shift.paidSeconds)}
        </span>
        {/* A break shorter than half a minute rounds to "0m", and "after 0m
            of breaks" reads as a bug rather than as a 13-second break — which
            is a real row in prod, seen on this page during the phase 2
            browser check. Say it in words below the rounding floor. */}
        {shift.breakSeconds > 0 && (
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {shift.breakSeconds >= 30
              ? `after ${formatHours(shift.breakSeconds)} of breaks`
              : 'after a break under a minute long'}
          </span>
        )}
        <span className="text-xs text-gray-400 whitespace-nowrap">
          in: {sourceLabel(shift.source)}
          {shift.closeSource ? ` · out: ${sourceLabel(shift.closeSource)}` : ''}
        </span>
        {open && (
          <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800 whitespace-nowrap">
            Clocked in now
          </span>
        )}
        {autoClosed &&
          (evidenceHref ? (
            <Link
              href={evidenceHref}
              className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 underline whitespace-nowrap"
            >
              Closed by the midnight sweep — check the van&apos;s day
            </Link>
          ) : (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 whitespace-nowrap">
              Closed by the midnight sweep — ask them what time they stopped
            </span>
          ))}
        {shift.manualBy && (
          <span className="text-xs text-gray-400">typed by {shift.manualBy}</span>
        )}
        <span className="ml-auto inline-flex items-center gap-3">
          <EditShiftTimes
            shiftId={shift.id}
            clockInAt={shift.clockInAt}
            clockOutAt={shift.clockOutAt}
          />
          {/* Only on rows the office TYPED: a shift the person clocked
              themselves is their own record and is corrected, never erased.
              This mirrors the FIRST of adminVoidShift's guards, not all of
              them — the server also refuses a row carrying a break or job
              segment, and that one is not mirrored here, so Remove can still
              come back with a refusal an admin reads inline (technical lens
              on PR #1178). Checking it client-side would mean shipping the
              child rows to the page for a case that has never occurred. */}
          {shift.removable && (
            <VoidShiftButton
              shiftId={shift.id}
              crewName={crewName}
              clockInAt={shift.clockInAt}
              clockOutAt={shift.clockOutAt}
            />
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * The day's GPS timeline, when there is one for this person.
 *
 * Only for FIELD crew: the two clocks page lists field shifts beside the van
 * track (fleetDay.ts drops is_office rows), so for office staff there is no
 * second record of the day and the badge must not pretend otherwise. Also
 * null for the sentinel 'unknown' day, which is not a date the page accepts.
 */
function evidenceHrefFor(isOffice: boolean, day: string): string | null {
  if (isOffice) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `/admin/fleet/clocks?date=${day}`;
}

export function PersonHoursSection({
  crewName,
  isOffice,
  days,
  range,
  totalSeconds,
  shiftCount,
  autoClosed,
  openShift,
  errors,
  basePath,
}: {
  crewName: string;
  /** Decides whether a midnight-closed shift can point at any evidence. */
  isOffice: boolean;
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
        Clocked time, day by day. Nothing here is approved or paid. A shift counts on the day it
        started (New York time) and is never split across midnight, so an overnight shift shows
        in full on the day it began.
      </p>

      {errors.length > 0 && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-medium">Some of this record could not be read, so it is incomplete.</p>
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
        {autoClosed.count > 0 && (
          <span className="text-sm text-amber-800">
            {autoClosed.count} closed by the midnight sweep, {formatHours(autoClosed.seconds)} of
            this total
          </span>
        )}
      </div>

      {days.length === 0 ? (
        <p className="text-sm text-gray-500">No shifts in this range.</p>
      ) : (
        <div className="space-y-4">
          {days.map((d) => (
            <div key={d.day} className="rounded-md border border-gray-200 overflow-hidden">
              <div className="flex items-baseline justify-between bg-gray-50 px-3 py-2">
                <h3 className="text-sm font-semibold text-gray-900">
                  {d.day === 'unknown' ? 'Date unreadable' : fmtDayKey(d.day)}
                </h3>
                <span className="text-sm tabular-nums text-gray-700">
                  {formatHours(d.paidSeconds)}
                </span>
              </div>
              <ul className="divide-y divide-gray-100">
                {d.shifts.map((s) => (
                  <ShiftRow
                    key={s.id}
                    shift={s}
                    crewName={crewName}
                    evidenceHref={evidenceHrefFor(isOffice, d.day)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<ShiftAuditEntry['action'], string> = {
  'shift-manual-create': 'Shift added by hand',
  'shift-manual-edit': 'Times corrected',
  'shift-manual-void': 'Shift removed',
  'shift-manual-void-aborted': 'Removal called off — nothing was removed',
};

function timePair(pair: { clockInAt: string | null; clockOutAt: string | null } | null): string {
  if (!pair) return '—';
  const start = pair.clockInAt ? fmtDateTime(pair.clockInAt) : '?';
  const end = pair.clockOutAt ? fmtDateTime(pair.clockOutAt) : 'still open';
  return `${start} → ${end}`;
}

/**
 * The manual-write trail for this person (ledger row 473).
 *
 * These entries have been written since PR #1062 and had no reader outside
 * the inbox activity feed, which has no label for them and caps at 100 rows
 * mixed in with customer history. For a REMOVED shift this entry is the only
 * surviving copy of what the row said, which is why it is worth a home.
 */
export function ShiftAuditSection({
  entries,
  partial,
}: {
  entries: ShiftAuditEntry[];
  partial: boolean;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Manual changes</h2>
      {/* NOT "every time" (admin lens on PR #1178). The audit row for a
          create or an edit is written best-effort — shifts.ts logs a failed
          insert and carries on, because the shift itself is still on screen
          and recoverable — so a change can land with no entry here. Only the
          VOID path refuses to proceed without its entry. Copy that promised
          completeness would make a missing entry read as "nobody touched
          it", which is the opposite of the truth. */}
      <p className="text-sm text-gray-500 mb-4">
        Changes made by hand to this person&apos;s shifts: added, corrected or removed. The clock
        itself is not listed here — only office edits. A removal cannot be recorded here and go
        ahead anyway, so a removed shift always leaves its entry, and that entry is the only
        surviving record of what the shift said. An add or a correction is recorded on a
        best-effort basis, so a gap here means it was not recorded, which is not the same as it
        not having happened.
      </p>

      {entries.length === 0 ? (
        <div className="rounded-md border border-gray-200 bg-white px-3 py-6 text-center">
          <p className="text-sm text-gray-500">No manual changes to this person&apos;s time.</p>
        </div>
      ) : (
        <ul className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100">
          {entries.map((e) => (
            <li key={e.id} className="px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-gray-900">{ACTION_LABEL[e.action]}</span>
                <span className="text-xs text-gray-500">by {e.actor}</span>
                <span className="text-xs text-gray-400">{fmtDateTime(e.at)} ET</span>
              </div>
              {e.action === 'shift-manual-void-aborted' ? (
                <p className="text-sm text-gray-600 mt-1">
                  The shift stayed on payroll{e.reason ? ` (${e.reason})` : ''}.
                </p>
              ) : (
                <p className="text-sm text-gray-600 mt-1 tabular-nums">
                  {e.before && <>was {timePair(e.before)}</>}
                  {e.before && e.after && <span className="text-gray-400"> · </span>}
                  {e.after ? <>now {timePair(e.after)}</> : e.before ? <>now removed</> : null}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {partial && (
        <p className="mt-2 text-xs text-gray-500">
          One or more called-off removals could not be tied to a person, so they are not listed
          here. That happens when the shift they referred to was later removed outright; the full
          list lives in the activity table.
        </p>
      )}
    </section>
  );
}
