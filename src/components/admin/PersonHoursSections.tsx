// One person's day-by-day hours and their manual-write trail, for
// /admin/time-tracking/[crewMemberId] (time-tracking plan phase 2).
//
// Server-renderable and presentational; the page loads `loadPersonTime` and
// passes the result in. The only interactive parts are the existing
// ManualShiftEditor client controls, which are the SAME components the two
// clocks page uses — one editor, not a second one that could drift from it.
// They are drawn by HoursDayList, which moved to components/time/ in phase 4
// so the staff self-view could share the row renderer without importing an
// admin module; it draws them only for `controls="admin"`, which is what this
// file passes and the self-view does not.
//
// The Hours section is HOURS ONLY, like phase 1: no rate, no money, no
// approval control. The Pay section below it is phase 3 and is where money
// lives on this page.

import Link from 'next/link';

import { HoursDayList, fmtTime, sourceLabel } from '@/components/time/HoursDayList';
import { ShiftPayPanel, VoidSettlementButton, type PayableShift } from '@/components/admin/ShiftPayPanel';
import { dollars, type PayableRemainder, type ShiftSettlement } from '@/lib/shiftSettlements';
import { formatHours } from '@/lib/hoursSummary';
import {
  RANGE_KEYS,
  rangeLabel,
  type PersonDay,
  type RangeKey,
  type ShiftAuditEntry,
} from '@/lib/personHours';

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

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
        Clocked time, day by day, with what has been paid for marked on each row. A shift counts
        on the day it started (New York time) and is never split across midnight, so an overnight
        shift shows in full on the day it began.
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
        <HoursDayList
          days={days}
          crewName={crewName}
          controls="admin"
          evidenceFor={(day) => evidenceHrefFor(isOffice, day)}
        />
      )}
    </section>
  );
}

/**
 * Recording what has been paid, and what is still owed against hours nobody
 * has been paid for — time-tracking plan phase 3, ledger row 459.
 *
 * The payable list is EVERY closed shift with time still owing, oldest first,
 * regardless of the range shown above it. Phase 3 scoped it to the chosen
 * range so an admin paying "the last two weeks" could not settle a shift from
 * March by accident; that protected a tick-box list which no longer exists.
 * The server now spends a payment across all unpaid shifts oldest first, so a
 * range-scoped list here would preview an allocation that is not the one
 * about to happen (two lenses on PR #1190, independently).
 */
export function ShiftPaySection({
  crewMemberId,
  crewName,
  rateCentsPerHour,
  remainders,
  settlements,
  settledCents,
  settlementsReadable,
  halfUndone,
}: {
  crewMemberId: string;
  crewName: string;
  rateCentsPerHour: number;
  /** Every closed shift with time still owing, oldest first, across ALL
   * time — not the range on screen. The server spends a payment globally
   * oldest-first, so a range-scoped list would preview the wrong shifts. */
  remainders: PayableRemainder[];
  settlements: ShiftSettlement[];
  settledCents: number;
  settlementsReadable: boolean;
  /** Payments whose shifts were released but which never got their own void
   * stamp. Running the undo again finishes them. */
  halfUndone: string[];
}) {
  // Already oldest-first and already filtered to what is still owing: this
  // is the SAME list the server spends the money over, so the preview and
  // the write cannot disagree about which shifts are in play.
  const payable: PayableShift[] = remainders
    .filter((r) => r.unpaidSeconds > 0)
    .map((r) => ({
      id: r.shiftId,
      clockInAt: r.clockInAt,
      paidSeconds: r.totalSeconds,
      unpaidSeconds: r.unpaidSeconds,
      // Carried through so the warning reaches the panel where paying LOCKS
      // these hours, not only the list above it.
      needsReview: r.needsReview,
    }));

  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Pay</h2>
      <p className="text-sm text-gray-500 mb-4">
        You pay {crewName} however you normally do, then record the amount here. The tool does not
        work out what to pay — it takes what you actually handed over and marks off that many
        hours, oldest first. Anything the money does not reach stays unpaid and carries over to
        the next payment. A shift a payment has touched is locked until that payment is undone.
      </p>

      {!settlementsReadable ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Payments could not be read, so nothing can be recorded here right now. The hours above
          are still correct; reload in a moment.
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
            <span className="text-sm text-gray-700">
              <span className="font-semibold tabular-nums">{dollars(settledCents)}</span> recorded
              as paid, all time
            </span>
            <span className="text-sm text-gray-500 tabular-nums">
              {payable.length} unpaid {payable.length === 1 ? 'shift' : 'shifts'}, all time
            </span>
          </div>

          {/* A payment stuck half-undone: its shifts were released but the
              payment never got its own stamp, so it reads as live while
              covering nothing. It is already excluded from the total above;
              this says how to finish it. */}
          {halfUndone.length > 0 && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {halfUndone.length === 1 ? 'One payment was' : `${halfUndone.length} payments were`}{' '}
              only half undone: the shifts were released but the record still reads as live, so it
              is not counted above. Press Undo on it again to finish.
            </div>
          )}

          {/* The range key is GONE (it was added by the staff lens on PR #1179
              to clear a selection when the range-scoped list changed
              underneath it). There is no selection any more, and this list no
              longer moves with the range, so keying on it would only throw
              away a typed amount when somebody switched range to look at the
              hours table above. */}
          <ShiftPayPanel
            crewMemberId={crewMemberId}
            crewName={crewName}
            rateCentsPerHour={rateCentsPerHour}
            payable={payable}
          />
          <p className="mt-2 text-xs text-gray-500">
            Every unpaid shift is listed here, however old — the range above changes the hours
            table, not this. A payment is always spent oldest first.
          </p>

          <h3 className="text-sm font-semibold text-gray-900 mt-6 mb-2">Payments recorded</h3>
          {settlements.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing recorded yet.</p>
          ) : (
            <ul className="rounded-md border border-gray-200 divide-y divide-gray-100">
              {settlements.map((st) => {
                const liveLines = st.lines.filter((l) => !l.voidedAt);
                return (
                  <li key={st.id} className={`px-3 py-2 ${st.voidedAt ? 'text-gray-400' : ''}`}>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-sm font-medium tabular-nums">
                        {dollars(st.totalCents)}
                      </span>
                      <span className="text-xs">{st.method}</span>
                      <span className="text-xs text-gray-400">{fmtDateTime(st.paidAt)} ET</span>
                      {st.paidBy && <span className="text-xs text-gray-400">by {st.paidBy}</span>}
                      <span className="text-xs text-gray-500">
                        {liveLines.length} {liveLines.length === 1 ? 'shift' : 'shifts'} ·{' '}
                        {formatHours(st.coveredSeconds)}
                        {/* Shown only when the reference differs by MORE THAN
                            ROUNDING, so a real gap (overtime, an advance) is
                            what stands out.

                            An exact !== fired on the very first real payment:
                            $180.01 of per-line references against $180.00
                            recorded, because each line rounds to its own cent
                            and the amount was rounded once as a whole. Since
                            the hours are now derived FROM the money, that is
                            the ordinary case rather than the interesting one,
                            so an exact test would light up on almost every
                            multi-shift payment and mean nothing. One cent per
                            line is the most rounding can account for. */}
                        {Math.abs(st.referenceCents - st.totalCents) > liveLines.length &&
                          !st.voidedAt && (
                            <> · {dollars(st.referenceCents)} at the stamped rate</>
                          )}
                      </span>
                      {st.voidedAt ? (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">
                          Undone{st.voidedBy ? ` by ${st.voidedBy}` : ''}
                          {st.voidReason ? `: ${st.voidReason}` : ''}
                        </span>
                      ) : (
                        <span className="ml-auto">
                          <VoidSettlementButton
                            settlementId={st.id}
                            crewName={crewName}
                            amountLabel={dollars(st.totalCents)}
                            shiftCount={liveLines.length}
                          />
                        </span>
                      )}
                    </div>
                    {st.note && <p className="text-xs text-gray-500 mt-1">{st.note}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
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
