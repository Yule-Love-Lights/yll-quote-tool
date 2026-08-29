// The fleet LIVE view (ledger row 403): the map and where each van is right
// now. Every office operator sees this page.
//
// The day's two clocks (payroll beside GPS) moved to /admin/fleet/clocks,
// which is ADMIN ONLY (Naldo, 2026-08-28) — the comparison is for him and
// Jason, not the whole office. The tab link below only renders for admins.

import { OperatorShell } from '@/components/OperatorShell';
import { loadFleetDay, fmtFleetTime } from '@/lib/fleetDay';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { FleetMap, type FleetMapPin } from '@/components/admin/FleetMap';
import { MinutesSince } from '@/components/admin/MinutesSince';
import { AutoRefresh } from '@/components/admin/AutoRefresh';
import { DEPOT } from '@/lib/integrations/vehicleProximity';

export const dynamic = 'force-dynamic';

export default async function FleetPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const today = etDayKey(new Date());
  // A ?date= bookmark from before the two pages split lands here and silently
  // shows TODAY, so a day someone meant to look at reads as an ordinary quiet
  // day (row 457b). The param no longer belongs to this page; say where it
  // went rather than answering a different question than the one asked.
  const params = (await searchParams) ?? {};
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const askedDate =
    rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && rawDate !== today ? rawDate : null;
  const [day, role] = await Promise.all([loadFleetDay(today), getSessionRole()]);

  const pins: FleetMapPin[] = day.vehicles
    .filter((v) => v.lastLat != null && v.lastLng != null && v.signal !== 'never')
    .map((v) => ({
      id: v.id,
      label: v.label,
      lat: v.lastLat as number,
      lng: v.lastLng as number,
      signal: v.signal as 'live' | 'stale',
      seenLabel: fmtFleetTime(v.lastSeenAt),
    }));

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
          <h1 className="text-xl font-semibold text-gray-900">Fleet</h1>
          <p className="text-sm text-gray-500 mt-1">Where the vans are right now.</p>
          {role === 'admin' && (
            <p className="text-sm mt-2 flex gap-4">
              <a href="/admin/fleet/clocks" className="underline text-gray-600">
                The day&apos;s two clocks →
              </a>
              {/* Same admin gate as the clocks link: /admin/time-tracking
                  redirects non-admins server-side, this only hides the door. */}
              <a href="/admin/time-tracking" className="underline text-gray-600">
                Time tracking →
              </a>
            </p>
          )}
        </div>

        {askedDate && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            You asked for {askedDate}, and this page only shows today. The day view moved to the
            two clocks page.{' '}
            {role === 'admin' ? (
              <a href={`/admin/fleet/clocks?date=${askedDate}`} className="underline">
                Open {askedDate} there
              </a>
            ) : (
              <>That page is admin only, so ask Naldo or Jason for that day.</>
            )}
          </div>
        )}

        {day.errors.length > 0 && (
          <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
            Some of this page could not load: {day.errors.join('; ')}
          </div>
        )}

        <AutoRefresh seconds={120} />

        {/* The same caveat the admin clocks page carries (row 457c). This page
            shows at-place timers to the WHOLE office, so the sentence that
            stops a timer being read as a person's hours belongs here too, not
            only on the page two people open. */}
        <p className="mb-6 text-sm text-gray-600">
          <strong className="text-gray-800">The van is not the person.</strong> Crew can be
          working after the van leaves, a van can sit somewhere while nobody works, and two
          people share one van. These timers say where a vehicle is, never who is on the clock.
        </p>

        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Vehicles now</h2>
          <FleetMap pins={pins} depot={{ lat: DEPOT.lat, lng: DEPOT.lng }} />
          <p className="text-xs text-gray-400 -mt-2 mb-4">
            Green pin: live. Amber pin: no signal, last known spot. Gray dot: depot. Updates every
            2 minutes.
          </p>
          <ul className="space-y-2">
            {day.vehicles.length === 0 && (
              <li className="text-sm text-gray-500">No vehicles registered.</li>
            )}
            {day.vehicles.map((v) => (
              <li key={v.id} className="rounded-lg border border-gray-200 p-3 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900">
                  {v.label}
                  {v.openVisit && (
                    <span className="font-normal text-gray-600">
                      {' '}
                      · At{' '}
                      {v.openVisit.kind === 'depot'
                        ? 'Depot'
                        : v.openVisit.jobNumber != null
                          ? `Job #${v.openVisit.jobNumber}`
                          : 'a job'}{' '}
                      since {fmtFleetTime(v.openVisit.enteredAt)} ·{' '}
                      <MinutesSince sinceIso={v.openVisit.enteredAt} />
                    </span>
                  )}
                </span>
                {v.signal === 'live' && v.lastLat != null && (
                  <a
                    className="text-sm underline"
                    style={{ color: 'var(--brand-evergreen-3)' }}
                    href={`https://www.google.com/maps?q=${v.lastLat},${v.lastLng}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Live · seen {fmtFleetTime(v.lastSeenAt)} · open map
                  </a>
                )}
                {v.signal === 'stale' && (
                  <span className="text-sm text-amber-700">
                    {v.openVisit
                      ? `Tracker asleep since ${fmtFleetTime(v.lastSeenAt)} (normal when parked)`
                      : `No signal since ${fmtFleetTime(v.lastSeenAt)} — position unknown, not parked`}
                  </span>
                )}
                {v.signal === 'never' && (
                  <span className="text-sm text-gray-500">No position reported yet</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-8 text-xs text-gray-400">
          <a href="/admin/geocoding" className="underline">
            Addresses needing fixes
          </a>{' '}
          — properties whose address could not be verified; their jobs cannot be scheduled.
        </p>
      </main>
    </OperatorShell>
  );
}
