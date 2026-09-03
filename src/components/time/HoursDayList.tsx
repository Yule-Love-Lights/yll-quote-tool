// The day-by-day shift list, shared by the ADMIN record
// (/admin/time-tracking/[crewMemberId]) and the STAFF self-view (/my-hours).
//
// It lives here rather than in components/admin because it is not an admin
// component: it renders one person's shifts, and the admin controls are a
// mode it can be ASKED for, never something it always carries. The two pages
// differ in voice and in what they may offer; how a single shift is
// DISPLAYED must not differ, and a second copy of this loop is how it would.
//
// Extracted from PersonHoursSections.tsx for time-tracking plan phase 4. The
// row markup is unchanged from phase 2 apart from the `controls` mode.

import Link from 'next/link';

import { EditShiftTimes, VoidShiftButton } from '@/components/admin/ManualShiftEditor';
import { formatHours } from '@/lib/hoursSummary';
import type { PersonDay, PersonShift } from '@/lib/personHours';

// ET regardless of the server's own timezone: prod renders on a UTC box.
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
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

export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

function ShiftRow({
  shift,
  crewName,
  evidenceHref,
  controls,
}: {
  shift: PersonShift;
  crewName: string;
  /**
   * 'admin' draws the edit / remove / paid-lock controls; 'none' draws no
   * control at all — the row is a record, not a form.
   *
   * REQUIRED, with no default, deliberately: the permissive value must never
   * be the one a caller gets by forgetting. 'none' is what the staff
   * self-view (phase 4) passes, where the controls must be ABSENT from the
   * markup rather than hidden by CSS.
   */
  controls: 'admin' | 'none';
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
              {/* Same fact, said to whoever is reading it. The admin is being
                  asked to go and find out; the person on the self-view IS the
                  one who knows, and telling them to "ask them" is nonsense on
                  their own shift. Caught by the phase 4 page test, which is
                  why the voice is a branch and not a comment. */}
              {controls === 'admin'
                ? 'Closed by the midnight sweep — ask them what time they stopped'
                : 'Closed by the midnight sweep — tell the office what time you stopped'}
            </span>
          ))}
        {shift.manualBy && (
          <span className="text-xs text-gray-400">typed by {shift.manualBy}</span>
        )}
        {controls === 'admin' && (
        <span className="ml-auto inline-flex items-center gap-3">
          {/* A paid shift is locked (ledger row 459): shifts.ts refuses both
              the edit and the void. Showing the controls anyway would be a
              door into a refusal, so the row says what is true and names the
              way out — undoing the payment releases it. The guard and the
              copy that narrates it are one change. */}
          {shift.settlementId ? (
            <span className="text-xs text-gray-500">
              Paid — undo the payment below to change these times
            </span>
          ) : (
            <EditShiftTimes
              shiftId={shift.id}
              clockInAt={shift.clockInAt}
              clockOutAt={shift.clockOutAt}
            />
          )}
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
        )}
      </div>
    </li>
  );
}

/**
 * The day-by-day list itself, shared by the admin record and the staff
 * self-view so one row renderer serves both. The two pages differ in VOICE
 * and in what they may offer, never in how a shift is displayed — a second
 * copy of this loop is how the two would drift.
 */
export function HoursDayList({
  days,
  crewName,
  controls,
  evidenceFor,
}: {
  days: PersonDay[];
  crewName: string;
  controls: 'admin' | 'none';
  /** Where to see what really happened that day, or null when nothing in the
   * app knows — or when the reader could not open it anyway. */
  evidenceFor: (day: string) => string | null;
}) {
  return (
    <div className="space-y-4">
      {days.map((d) => (
        <div key={d.day} className="rounded-md border border-gray-200 overflow-hidden">
          <div className="flex items-baseline justify-between bg-gray-50 px-3 py-2">
            <h3 className="text-sm font-semibold text-gray-900">
              {d.day === 'unknown' ? 'Date unreadable' : fmtDayKey(d.day)}
            </h3>
            <span className="text-sm tabular-nums text-gray-700">{formatHours(d.paidSeconds)}</span>
          </div>
          <ul className="divide-y divide-gray-100">
            {d.shifts.map((s) => (
              <ShiftRow
                key={s.id}
                shift={s}
                crewName={crewName}
                evidenceHref={evidenceFor(d.day)}
                controls={controls}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
