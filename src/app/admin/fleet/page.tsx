// The fleet day view (ledger row 403): where the vans are now, and the two
// clocks side by side for one day.
//
// OFFICE ONLY (Naldo, 2026-08-27). Operator session, like all of /admin; the
// crew do not see this page.
//
// The banner about the van not being the person is rendered ON the page, not
// buried in a doc: this is the screen where someone might otherwise read a gap
// between the clocks as an accusation, and the reminder belongs at the moment
// of reading, every time.

import { OperatorShell } from '@/components/OperatorShell';
import { loadFleetDay, listFleetDays, MIN_DWELL_MINUTES } from '@/lib/fleetDay';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { FleetMap, type FleetMapPin } from '@/components/admin/FleetMap';
import { MinutesSince } from '@/components/admin/MinutesSince';
import { DEPOT } from '@/lib/integrations/vehicleProximity';

export const dynamic = 'force-dynamic';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function FleetPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const raw = Array.isArray(params.date) ? params.date[0] : params.date;
  const today = etDayKey(new Date());
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today;
  const [day, daysWithData] = await Promise.all([loadFleetDay(date), listFleetDays()]);
  const isToday = date === today;

  const pins: FleetMapPin[] = day.vehicles
    .filter((v) => v.lastLat != null && v.lastLng != null && v.signal !== 'never')
    .map((v) => ({
      id: v.id,
      label: v.label,
      lat: v.lastLat as number,
      lng: v.lastLng as number,
      signal: v.signal as 'live' | 'stale',
      seenLabel: fmtTime(v.lastSeenAt),
    }));

  return (
    <OperatorShell active="jobs">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Fleet — {date}</h1>
          <p className="text-sm text-gray-500 mt-1">
            Where the vans are, and the day&apos;s two clocks side by side.
          </p>
          <form method="get" className="mt-3 flex items-center gap-2 text-sm">
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
              <a href="/admin/fleet" className="underline text-gray-600">
                today
              </a>
            )}
          </form>
          {daysWithData.length > 0 && (
            <p className="text-sm text-gray-500 mt-2">
              Days with data:{' '}
              {daysWithData.map((d, i) => (
                <span key={d}>
                  {i > 0 && ' · '}
                  {d === date ? (
                    <span className="font-medium text-gray-900">{d}</span>
                  ) : (
                    <a href={`/admin/fleet?date=${d}`} className="underline">
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

        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Vehicles now</h2>
          <FleetMap pins={pins} depot={{ lat: DEPOT.lat, lng: DEPOT.lng }} />
          <ul className="space-y-2">
            {day.vehicles.length === 0 && (
              <li className="text-sm text-gray-500">No vehicles registered.</li>
            )}
            {day.vehicles.map((v) => (
              <li key={v.id} className="rounded-lg border border-gray-200 p-3 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900">
                  {v.label}
                  {isToday && v.signal === 'live' && v.openVisit && (
                    <span className="font-normal text-gray-600">
                      {' '}
                      · At{' '}
                      {v.openVisit.kind === 'depot'
                        ? 'Depot'
                        : v.openVisit.jobNumber != null
                          ? `Job #${v.openVisit.jobNumber}`
                          : 'a job'}{' '}
                      · <MinutesSince sinceIso={v.openVisit.enteredAt} />
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
                    Live · seen {fmtTime(v.lastSeenAt)} · open map
                  </a>
                )}
                {v.signal === 'stale' && (
                  <span className="text-sm text-amber-700">
                    No signal since {fmtTime(v.lastSeenAt)} — position unknown, not parked
                  </span>
                )}
                {v.signal === 'never' && (
                  <span className="text-sm text-gray-500">No position reported yet</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
          <strong className="text-gray-800">The van is not the person.</strong> Crew can be working
          after the van leaves, a van can sit somewhere while nobody works, and two people share
          one van. When the two clocks disagree, that is a question to ask, not an answer. The
          crew&apos;s own clock below is the payroll record; the GPS side never touches pay.
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Crew clock (payroll)</h2>
            {day.shifts.length === 0 ? (
              <p className="text-sm text-gray-500">No shifts recorded this day.</p>
            ) : (
              <ul className="space-y-2">
                {day.shifts.map((s, i) => (
                  <li key={i} className="rounded-lg border border-gray-200 p-3 text-sm">
                    <span className="font-medium text-gray-900">{s.crewName}</span>
                    <span className="text-gray-600">
                      {' '}
                      · in {fmtTime(s.clockInAt)} · out {fmtTime(s.clockOutAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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
                      {fmtTime(v.enteredAt)} →{' '}
                      {v.exitedAt
                        ? fmtTime(v.exitedAt)
                        : v.vehicleSignal === 'live'
                          ? 'still there'
                          : `last seen ${fmtTime(v.vehicleLastSeenAt)} — no signal, may have left`}
                      {v.minutes != null && ` · ${v.minutes} min`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

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
