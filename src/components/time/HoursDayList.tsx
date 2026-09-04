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
//
// S62 restyled the rows (one continuous list with a tinted band per day, the
// duration leading, the meta text quiet) and changed nothing about WHAT a
// row says: every string here is the one the tests pin, and the placeholder
// / sweep / paid logic is byte-for-byte the S61 logic.

import Link from 'next/link';

import { EditShiftTimes, VoidShiftButton } from '@/components/admin/ManualShiftEditor';
import { Pill, pillClass } from '@/components/time/timeUi';
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

/** The `manual_by` stamp the row-507 timesheet import writes on every shift
 * it creates. Matched as a prefix so the stamp can gain detail later. */
const IMPORT_STAMP_PREFIX = 'imported from';

/** True when this row's clock times are a PLACEHOLDER rather than a punch.
 *
 * The row-507 import had a date and a duration and no start time, so every
 * imported shift is anchored at a fixed hour. Those rows are `source: office`,
 * which SOURCE_LABEL renders as "web clock" — so without this they read as
 * ordinary punches with precise times, and 142 of Jason's do. The day and the
 * duration are real; the clock times are not, and the row now says so (admin
 * lens, S61 session review). */
export function hasPlaceholderTimes(manualBy: string | null): boolean {
  return manualBy !== null && manualBy.startsWith(IMPORT_STAMP_PREFIX);
}

/**
 * Who typed a manual correction, as the reader of THIS page should see them.
 *
 * `manual_by` is stamped by `gateActor` as `"Name (email)"` whenever the
 * operator has both — which is every real admin session. That was fine while
 * this string only ever appeared on an admin-only page (phase 2). Phase 4 is
 * the first time it reaches a non-admin: without this, the moment an admin
 * hand-corrects a swept shift, the person whose shift it was reads their
 * boss's real login email on their own hours page. The midnight sweep alone
 * has touched 5 of 27 real shifts, so this is an everyday path, not a corner.
 *
 * The NAME still shows on both pages — knowing who changed your hours is the
 * point of the stamp, and phase 2's audit trail exists to say so. Only the
 * parenthetical login identifier is dropped, and only for the self-view;
 * admins keep the full string, which is what makes the two rows distinguish
 * two people with the same first name.
 *
 * PURE, and exported for its own test: a fallback that silently returned the
 * whole string would put the email back with nothing failing.
 */
export function actorLabel(manualBy: string, controls: 'admin' | 'none'): string {
  if (controls === 'admin') return manualBy;
  const open = manualBy.lastIndexOf(' (');
  // No parenthetical (gateActor's name-only or email-only fallbacks) — return
  // it as it stands. An email-only stamp is the one case this cannot improve:
  // there is no name to fall back to, and inventing "an admin" would hide who
  // it was on the page whose whole job is saying so.
  if (open <= 0 || !manualBy.endsWith(')')) return manualBy;
  return manualBy.slice(0, open);
}

function ShiftRow({
  shift,
  crewName,
  evidenceHref,
  controls,
  showPaidMarks,
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
  /** Draw the "Paid" mark on a settled shift. Only meaningful for
   * `controls: 'none'` (the admin row says it inside its own controls block),
   * and FALSE when the settlement read failed, so an unreadable answer never
   * renders as "not paid". */
  showPaidMarks: boolean;
}) {
  const open = shift.clockOutAt === null;
  const autoClosed = shift.closeSource === 'system';
  const placeholder = hasPlaceholderTimes(shift.manualBy);
  // A swept shift that an admin has since typed over keeps `close_source:
  // 'system'` forever, so the badge kept asking for a correction that had
  // already been made — seen live on a real row, sitting directly above its
  // own "typed by" stamp. The fact stays (the times were not clocked, they
  // were entered), the call to action goes.
  const corrected = autoClosed && shift.manualBy !== null;
  const sweepNote = corrected
    ? 'Closed by the midnight sweep, since corrected'
    : controls === 'admin'
      ? // The admin is being asked to go and find out; the person on the
        // self-view IS the one who knows, and "ask them" is nonsense on their
        // own shift. Caught by the phase 4 page test, which is why the voice
        // is a branch and not a comment.
        'Closed by the midnight sweep — ask them what time they stopped'
      : 'Closed by the midnight sweep — tell the office what time you stopped';
  // On the self-view a shift a payment has covered in full is tinted green
  // (Jason, 2026-09-04, from his own phone), so the paid/unpaid split reads
  // down the list without hunting for the pill. Same condition as the "Paid"
  // pill below, so the tint and the word cannot disagree: it needs a
  // trustworthy settlement read (showPaidMarks) and the WHOLE shift covered.
  // A half-paid shift stays white and says so on its pill.
  const paidInFull =
    showPaidMarks &&
    controls === 'none' &&
    shift.settledSeconds > 0 &&
    shift.settledSeconds >= shift.paidSeconds;
  return (
    <li className={`px-4 py-2.5 sm:px-5${paidInFull ? ' bg-green-50' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {/* The duration leads: it is the payroll fact. The clock times follow,
            and on a placeholder row they step back to grey, because a
            precise-looking 9:00 AM that nobody punched should not read like
            one that somebody did. */}
        <span className="flex items-baseline gap-3 whitespace-nowrap">
          <span className="text-sm font-semibold tabular-nums text-gray-900">
            {formatHours(shift.paidSeconds)}
          </span>
          <span
            className={`text-sm tabular-nums ${placeholder ? 'text-gray-400' : 'text-gray-700'}`}
          >
            {fmtTime(shift.clockInAt)} – {open ? 'still open' : fmtTime(shift.clockOutAt as string)}
          </span>
        </span>

        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          {/* A break shorter than half a minute rounds to "0m", and "after 0m
              of breaks" reads as a bug rather than as a 13-second break — which
              is a real row in prod, seen on this page during the phase 2
              browser check. Say it in words below the rounding floor. */}
          {shift.breakSeconds > 0 && (
            <span className="whitespace-nowrap">
              {shift.breakSeconds >= 30
                ? `after ${formatHours(shift.breakSeconds)} of breaks`
                : 'after a break under a minute long'}
            </span>
          )}
          <span className="whitespace-nowrap text-gray-400">
            {placeholder ? (
              'imported from a timesheet'
            ) : (
              <>
                in: {sourceLabel(shift.source)}
                {shift.closeSource ? ` · out: ${sourceLabel(shift.closeSource)}` : ''}
              </>
            )}
          </span>
          {placeholder && <Pill nowrap>start time approximate</Pill>}
          {open && (
            <Pill tone="green" nowrap>
              Clocked in now
            </Pill>
          )}
          {/* NOT nowrap. This is the longest string on the row and the list
              around it clips overflow, so at 375px a non-wrapping badge is
              CLIPPED rather than pushed — measured on the live page at 385px
              of text inside a 359px card, losing the last 55 pixels
              mid-sentence ("...tell the office what time you"). The clip also
              means a page-level overflow check reports zero, so nothing but
              looking would have caught it. Pre-existing on the admin page
              since phase 2; fixed in phase 4 for both, since both read this
              row. */}
          {autoClosed &&
            (evidenceHref && !corrected ? (
              <Link href={evidenceHref} className={`${pillClass('amber')} underline`}>
                Closed by the midnight sweep — check the van&apos;s day
              </Link>
            ) : (
              <Pill tone="amber">{sweepNote}</Pill>
            ))}
          {/* A record, not a control: the staff page cannot undo a payment,
              and the amount is never shown here (hours only — the office
              records what was paid, which is not always hours times a rate). */}
          {showPaidMarks && controls === 'none' && shift.settledSeconds > 0 && (
            <Pill tone="neutral">
              {shift.settledSeconds >= shift.paidSeconds
                ? 'Paid'
                : // A payment can stop half way through a shift, and saying
                  // only "Paid" there would claim money that was never handed
                  // over. The rest has rolled over to the next payment.
                  `${formatHours(shift.settledSeconds)} of ${formatHours(shift.paidSeconds)} paid`}
            </Pill>
          )}
          {/* Not on a placeholder row: its stamp is the import's own name,
              which "imported from a timesheet" already says, and 142 of one
              person's rows carrying "typed by imported from Time
              Tracker.xlsx (row 507)" was most of what made the page unreadable
              (S62). A real manual edit keeps its "typed by". */}
          {shift.manualBy && !placeholder && (
            <span className="text-gray-400">typed by {actorLabel(shift.manualBy, controls)}</span>
          )}
        </span>

        {controls === 'admin' && (
          <span className="ml-auto inline-flex items-center gap-3">
            {/* A paid shift is locked (ledger row 459): shifts.ts refuses both
                the edit and the void. Showing the controls anyway would be a
                door into a refusal, so the row says what is true and names
                the way out — undoing the payment releases it. The guard and
                the copy that narrates it are one change. */}
            {shift.settlementId ? (
              <span className="text-xs text-gray-500">
                {/* A payment can now cover PART of a shift, and a bare "Paid"
                    on a row that is half covered claims money that was never
                    handed over for it. Seen live on a real row during the
                    browser check. The LOCK is unconditional either way: any
                    live payment refuses an edit. */}
                {shift.settledSeconds > 0 && shift.settledSeconds < shift.paidSeconds
                  ? `${formatHours(shift.settledSeconds)} of this is paid — undo the payment below to change these times`
                  : 'Paid — undo the payment below to change these times'}
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
                segment, and that one is not mirrored here, so Remove can
                still come back with a refusal an admin reads inline
                (technical lens on PR #1178). Checking it client-side would
                mean shipping the child rows to the page for a case that has
                never occurred. */}
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
 *
 * Draws no frame of its own: the caller's Card provides it (`flush`), and
 * each day is a tinted band followed by its rows, so 142 single-shift days
 * read as one table rather than 142 boxes.
 */
export function HoursDayList({
  days,
  crewName,
  controls,
  evidenceFor,
  showPaidMarks = false,
}: {
  days: PersonDay[];
  crewName: string;
  controls: 'admin' | 'none';
  /** Draw a "Paid" mark on settled shifts. Defaults to FALSE: the admin row
   * already states the lock inside its controls, and a caller that has not
   * thought about whether its settlement data is trustworthy must not get a
   * payment claim by accident. */
  showPaidMarks?: boolean;
  /** Where to see what really happened that day, or null when nothing in the
   * app knows — or when the reader could not open it anyway. */
  evidenceFor: (day: string) => string | null;
}) {
  return (
    <div className="divide-y divide-gray-100">
      {days.map((d) => (
        <div key={d.day}>
          <div
            className="flex items-baseline justify-between px-4 py-1.5 sm:px-5"
            style={{ background: 'var(--op-bg)' }}
          >
            <h3
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--op-text-2)' }}
            >
              {d.day === 'unknown' ? 'Date unreadable' : fmtDayKey(d.day)}
            </h3>
            <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--op-text-2)' }}>
              {formatHours(d.paidSeconds)}
            </span>
          </div>
          <ul className="divide-y divide-gray-100">
            {d.shifts.map((s) => (
              <ShiftRow
                key={s.id}
                shift={s}
                crewName={crewName}
                evidenceHref={evidenceFor(d.day)}
                controls={controls}
                showPaidMarks={showPaidMarks}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
