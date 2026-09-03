// The day's two clocks: the crew's payroll clock beside the GPS timeline, for
// one chosen day. ADMIN ONLY (Naldo, 2026-08-28): this comparison is for him
// and Jason; any other operator is sent back to the live fleet page. The gate
// runs server-side on the session role, not in the UI.

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { loadFleetDay, listFleetDays, fmtFleetTime, MIN_DWELL_MINUTES } from '@/lib/fleetDay';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { addDays } from '@/lib/opsMidnightClose';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { listActiveFieldCrew } from '@/lib/crewMembers';
import { MinutesSince } from '@/components/admin/MinutesSince';
import { AutoRefresh } from '@/components/admin/AutoRefresh';
import { AddShiftForm, EditShiftTimes, VoidShiftButton } from '@/components/admin/ManualShiftEditor';

export const dynamic = 'force-dynamic';

export default async function FleetClocksPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const role = await getSessionRole();
  // Straight to the schedule, not to /admin/fleet: that route is itself a
  // redirect as of 2026-08-31, and a non-admin arriving here should land in
  // one hop rather than two.
  if (role !== 'admin') redirect('/admin/schedule');

  const params = (await searchParams) ?? {};
  const raw = Array.isArray(params.date) ? params.date[0] : params.date;
  const today = etDayKey(new Date());
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today;
  const [day, daysWithData, fieldCrew] = await Promise.all([
    loadFleetDay(date),
    listFleetDays(),
    listActiveFieldCrew(),
  ]);
  const isToday = date === today;
  // null from either loader means the read FAILED, which must never render as
  // "nobody is on the roster" or "no other days have data" (row 455 / row 457d).
  const crewOptions = (fieldCrew ?? []).map((c) => ({ id: c.id, displayName: c.displayName }));

  return (
    <OperatorShell active="fleet">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">
            The day&apos;s two clocks — {date}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            The crew&apos;s own clock (payroll) beside what the GPS saw. Only admins see this
            page.
          </p>
          <p className="text-sm mt-2">
            <a href="/admin/fleet" className="underline text-gray-600">
              ← live fleet view
            </a>
          </p>
          <form method="get" className="mt-3 flex items-center gap-2 text-sm">
            <a
              href={`/admin/fleet/clocks?date=${addDays(date, -1)}`}
              className="underline text-gray-600"
            >
              ← previous
            </a>
            <input
              type="date"
              name="date"
              defaultValue={date}
              className="rounded border border-gray-300 px-2 py-1"
            />
            <button type="submit" className="rounded border border-gray-300 px-3 py-1 text-gray-700">
              Go
            </button>
            {!isToday && (
              <>
                <a
                  href={`/admin/fleet/clocks?date=${addDays(date, 1)}`}
                  className="underline text-gray-600"
                >
                  next →
                </a>
                <a href="/admin/fleet/clocks" className="underline text-gray-600">
                  today
                </a>
              </>
            )}
          </form>
          {daysWithData === null && (
            <p className="text-sm text-red-700 mt-2">
              The list of days with data could not be loaded. Other days may still have data;
              type a date above to look at one.
            </p>
          )}
          {daysWithData !== null && daysWithData.length > 0 && (
            <p className="text-sm text-gray-500 mt-2">
              Days with data:{' '}
              {daysWithData.map((d, i) => (
                <span key={d}>
                  {i > 0 && ' · '}
                  {d === date ? (
                    <span className="font-medium text-gray-900">{d}</span>
                  ) : (
                    <a href={`/admin/fleet/clocks?date=${d}`} className="underline">
                      {d}
                    </a>
                  )}
                </span>
              ))}
            </p>
          )}
        </div>

        {day.errors.length > 0 && (
          <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
            Some of this page could not load: {day.errors.join('; ')}
          </div>
        )}

        {isToday && <AutoRefresh seconds={120} />}

        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
          <strong className="text-gray-800">The van is not the person.</strong> Crew can be
          working after the van leaves, a van can sit somewhere while nobody works, and two
          people share one van. When the two clocks disagree, that is a question to ask, not an
          answer. The crew&apos;s own clock below is the payroll record; the GPS side never
          touches pay.
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Crew clock (payroll)</h2>
            <p className="text-xs text-gray-400 mb-2">
              Field crew only. Office staff clock in from the dashboard header and are not shown
              here.
            </p>
            {day.shifts.length === 0 ? (
              <p className="text-sm text-gray-500">No shifts recorded this day.</p>
            ) : (
              <ul className="space-y-2">
                {day.shifts.map((s) => (
                  <li key={s.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                    <span className="font-medium text-gray-900">{s.crewName}</span>
                    <span className="text-gray-600">
                      {' '}
                      · in {fmtFleetTime(s.clockInAt)} · out {fmtFleetTime(s.clockOutAt)}{' '}
                    </span>
                    {/* A paid shift is locked (ledger row 459) and shifts.ts
                        refuses both writes, so the row says so instead of
                        offering a control that answers with a 409. The
                        person's own page already did this; THIS sibling
                        surface was missed when the guard shipped, and only a
                        whole-session integration lens could see it, because
                        this file was in none of the four PRs' diffs. */}
                    {s.paidAndLocked ? (
                      <span className="text-xs text-gray-500">
                        Paid — undo the payment on their{' '}
                        <Link href="/admin/time-tracking" className="underline">
                          hours page
                        </Link>{' '}
                        to change these times
                      </span>
                    ) : (
                      <>
                        <EditShiftTimes
                          shiftId={s.id}
                          clockInAt={s.clockInAt}
                          clockOutAt={s.clockOutAt}
                        />
                        {s.officeEntry && (
                          <>
                            {' · '}
                            <VoidShiftButton
                              shiftId={s.id}
                              crewName={s.crewName}
                              clockInAt={s.clockInAt}
                              clockOutAt={s.clockOutAt}
                            />
                          </>
                        )}
                      </>
                    )}
                    {s.manualBy && (
                      <p className="text-xs text-amber-700 mt-1">Manual entry by {s.manualBy}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {fieldCrew === null && (
              <p className="text-xs text-red-700 mt-3">
                The crew list could not be loaded, so the Add a shift form is not showing at
                all. Reload the page before typing a shift.
              </p>
            )}
            <AddShiftForm crew={crewOptions} defaultDate={date} />
          </section>

          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">GPS timeline (vehicles)</h2>
            {day.visits.length === 0 ? (
              <p className="text-sm text-gray-500">No vehicle visits recorded this day.</p>
            ) : (
              <ul className="space-y-2">
                {day.visits.map((v, i) => (
                  <li key={i} className="rounded-lg border border-gray-200 p-3 text-sm">
                    <div className="flex items-baseline justify-between">
                      <span className="font-medium text-gray-900">
                        {v.vehicleLabel} ·{' '}
                        {v.kind === 'depot' ? 'Depot' : (v.jobNumber != null ? `Job #${v.jobNumber}` : 'Job')}
                      </span>
                      {v.belowMinDwell === true && (
                        <span className="text-xs text-amber-700">
                          under {MIN_DWELL_MINUTES} min
                        </span>
                      )}
                    </div>
                    {v.kind === 'job' && v.address && <p className="text-gray-500">{v.address}</p>}
                    <p className="text-gray-600">
                      {fmtFleetTime(v.enteredAt)} →{' '}
                      {v.exitedAt
                        ? fmtFleetTime(v.exitedAt)
                        : v.vehicleSignal === 'live'
                          ? 'still there'
                          : `still there (tracker asleep since ${fmtFleetTime(v.vehicleLastSeenAt)})`}
                      {v.minutes != null && ` · ${v.minutes} min`}
                      {v.exitedAt === null && isToday && (
                        <>
                          {' · '}
                          <MinutesSince sinceIso={v.enteredAt} /> so far
                        </>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </OperatorShell>
  );
}
