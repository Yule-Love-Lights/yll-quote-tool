// The fleet live view: the map and where each van is right now.
//
// This was the whole of /admin/fleet until 2026-08-31, when Naldo folded it
// into the right column of the Schedule page. The page is gone (it redirects
// here) and the content moved wholesale, so nothing an operator could see
// before disappeared: the map, the vehicle list, the van-is-not-the-person
// caveat and the admin-only links all came across.
//
// Rendered only on TODAY (Naldo's call): the schedule has a day picker and
// these positions are always live, so showing them beside next Tuesday would
// pair a future day's jobs with this minute's vans. ScheduleWithFleet does
// that gating; this component just renders what it is given.
//
// A server component, like the page it came from: it does its own reads.

import Link from 'next/link';

import { loadFleetDay, fmtFleetTime } from '@/lib/fleetDay';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { FleetMap, type FleetMapPin } from '@/components/admin/FleetMap';
import { MinutesSince } from '@/components/admin/MinutesSince';
import { AutoRefresh } from '@/components/admin/AutoRefresh';
import { DEPOT } from '@/lib/integrations/vehicleProximity';

export async function FleetPanel() {
  const today = etDayKey(new Date());
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
    <section aria-labelledby="fleet-panel-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="fleet-panel-heading" className="text-sm font-semibold text-gray-900">
          Vehicles now
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">Where the vans are, this minute.</p>
      </div>

      {day.errors.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Some of this could not load: {day.errors.join('; ')}
        </div>
      )}

      <AutoRefresh seconds={120} />

      <div>
        <FleetMap pins={pins} depot={{ lat: DEPOT.lat, lng: DEPOT.lng }} />
        <p className="text-xs text-gray-400 -mt-2">
          Green pin: live. Amber pin: no signal, last known spot. Gray dot: depot. Updates every
          2 minutes.
        </p>
      </div>

      <ul className="space-y-2">
        {day.vehicles.length === 0 && (
          <li className="text-sm text-gray-500">No vehicles registered.</li>
        )}
        {day.vehicles.map((v) => (
          <li key={v.id} className="rounded-lg border border-gray-200 p-3 flex flex-col gap-1">
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

      {/* The caveat that stops an at-place timer being read as a person's
          hours. It shipped on the fleet page for the whole office (row 457c)
          and has to come with the content, not be left behind on a page that
          no longer exists. */}
      <p className="text-sm text-gray-600">
        <strong className="text-gray-800">The van is not the person.</strong> Crew can be working
        after the van leaves, a van can sit somewhere while nobody works, and two people share one
        van. These timers say where a vehicle is, never who is on the clock.
      </p>

      {role === 'admin' && (
        <p className="text-sm flex flex-col gap-1">
          {/* Same admin gate the fleet page carried: /admin/fleet/clocks and
              /admin/time-tracking redirect non-admins server-side, this only
              hides the door. */}
          <a href="/admin/fleet/clocks" className="underline text-gray-600">
            The day&apos;s two clocks →
          </a>
          {/* next/link, not <a>: /admin/time-tracking gained a dynamic
              child route (the per-person page), so the Next lint rule now
              resolves this href to a real page and requires Link. */}
          <Link href="/admin/time-tracking" className="underline text-gray-600">
            Time tracking →
          </Link>
        </p>
      )}

      <p className="text-xs text-gray-400">
        <a href="/admin/geocoding" className="underline">
          Addresses needing fixes
        </a>{' '}
        — properties whose address could not be verified; their jobs cannot be scheduled.
      </p>
    </section>
  );
}
