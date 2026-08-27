// src/lib/integrations/vehicleProximity.ts — the polling proximity engine
// (ledger row 403; replaces the Bouncie-geofence design).
//
// NALDO'S QUESTION, 2026-08-27, which set this design: "why are the customer's
// home coordinates going to Bouncie? The tool is the one triggering the
// notifications and the tracking." He was right. This module polls
// `GET /v1/vehicles` for each van's position and does the proximity maths HERE,
// against coordinates that never leave our database. Bouncie learns nothing
// about any customer.
//
// THE SCHEDULE IS THE WATCH LIST (Naldo: "the scheduler is the source of
// truth"). At each poll, the jobs scheduled for today's ET business day plus the
// depot are the only places a vehicle can "visit". Nothing is armed or retired,
// nothing lives in a vendor account, and a job with no verified coordinate
// cannot even reach the schedule (the assignCrewToJob gate), so every watched
// job is watchable by construction.
//
// THE SECOND CLOCK, UNCHANGED. Crew clock in and out by hand and that stays the
// payroll record. This file writes `vehicle_visits` and the `vehicles` position
// columns, and NOTHING else — no `shifts`, no `job_segments`, and a test pins
// the table list. Row 403 constraint (a).
//
// POLLING ALSO KEEPS THE GRANT ALIVE (ledger row 430). Bouncie's refresh token
// expires if unused; a poller that runs all day makes disuse impossible.

import { bouncieFetch } from '@/lib/integrations/bouncieAuth';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';

/**
 * How close a van must be to a property's coordinate to count as being there,
 * in metres. Still a considered guess (ledger row 432) — but in the polling
 * design a bad radius is a ONE-LINE tune with full retroactive context, because
 * every visit stores the entry position it was computed from.
 */
export const PROXIMITY_RADIUS_METRES = 120;

/**
 * Naldo's rule, 2026-08-27: fifteen minutes on site is a real visit. Shorter
 * stays are recorded and flagged, not discarded — a drive-by that trips the
 * radius is exactly the data needed to tune the radius.
 */
export const MIN_DWELL_MINUTES = 15;

/**
 * A position older than this is "no signal", not a location. Row 403
 * constraint (c): an unplugged or silent device must never read as "not at the
 * job" — or as still sitting wherever it last reported.
 */
export const STALE_POSITION_MINUTES = 10;

/**
 * The day-start anchor: 6 Birch Road, Amityville NY 11701, confirmed by Naldo
 * 2026-08-27 (he first wrote "Bridge", then corrected to Birch — the coordinate
 * below is the ROOFTOP-verified geocode from the phase-1 backfill, not a fresh
 * guess). Leaving here with jobs on the schedule is the "day started" signal.
 */
export const DEPOT = { lat: 40.711038, lng: -73.403885 } as const;

const EARTH_RADIUS_METRES = 6_371_000;

/** Great-circle distance in metres. Plenty accurate at town scale. */
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h));
}

export type WatchedPlace = { kind: 'job' | 'depot'; jobId: string | null; lat: number; lng: number };

/**
 * Which watched place a position is at, if any.
 *
 * OVERLAPS: several houses on one street can sit within one radius of each
 * other. Naldo's rule is that the SCHEDULER decides which job comes first; the
 * schedule has no ordering yet (that feature is unbuilt), so until it exists the
 * nearest anchor wins — the van is almost always physically closest to the job
 * it is actually at. When day-ordering ships, sequence becomes the tie-break
 * here, in this one function.
 */
export function resolvePlace(
  position: { lat: number; lng: number },
  places: WatchedPlace[],
  radiusMetres = PROXIMITY_RADIUS_METRES,
): WatchedPlace | null {
  let best: WatchedPlace | null = null;
  let bestDistance = Infinity;
  for (const place of places) {
    const d = distanceMetres(position, place);
    if (d <= radiusMetres && d < bestDistance) {
      best = place;
      bestDistance = d;
    }
  }
  return best;
}

type BouncieVehicle = {
  imei?: string;
  stats?: {
    lastUpdated?: string;
    location?: { lat?: number; lon?: number };
  };
};

export type PollOutcome = {
  polled: number;
  opened: number;
  closed: number;
  noSignal: number;
  errors: string[];
};

/**
 * One poll cycle: read every van's position, update the map columns, and open
 * or close visits against today's schedule.
 *
 * Every read checks its error and reports it — the geofence draft's "arm
 * nothing and report a clean run" failure is the one this engine must never
 * repeat.
 */
export async function pollVehiclePositions(now: Date = new Date()): Promise<PollOutcome> {
  const outcome: PollOutcome = { polled: 0, opened: 0, closed: 0, noSignal: 0, errors: [] };
  const sb = getSupabaseServiceClient();
  if (!sb) {
    outcome.errors.push('no service client');
    return outcome;
  }

  // Our registered vehicles.
  const vehiclesRes = await sb
    .from('vehicles')
    .select('id, imei, label')
    .eq('active', true)
    .not('imei', 'is', null)
    .returns<{ id: string; imei: string; label: string }[]>();
  if (vehiclesRes.error) {
    outcome.errors.push(`reading vehicles: ${vehiclesRes.error.message}`);
    return outcome;
  }
  const vehicles = vehiclesRes.data ?? [];
  if (!vehicles.length) return outcome;

  // Bouncie's current view of the fleet. ONE call per cycle for all vehicles —
  // this is also what keeps the OAuth grant alive (row 430).
  let remote: BouncieVehicle[];
  try {
    const res = await bouncieFetch('/vehicles');
    if (!res.ok) {
      outcome.errors.push(`GET /vehicles returned ${res.status}`);
      return outcome;
    }
    const body = (await res.json().catch(() => null)) as unknown;
    remote = Array.isArray(body) ? (body as BouncieVehicle[]) : [];
  } catch (err) {
    outcome.errors.push(err instanceof Error ? err.message : String(err));
    return outcome;
  }
  const byImei = new Map(remote.filter((v) => typeof v.imei === 'string').map((v) => [v.imei!, v]));

  // Today's watch list: the depot plus every scheduled job's property.
  const places: WatchedPlace[] = [{ kind: 'depot', jobId: null, lat: DEPOT.lat, lng: DEPOT.lng }];
  const today = etDayKey(now);
  const assignmentsRes = await sb
    .from('job_assignments')
    .select('job_id')
    .eq('assigned_date', today)
    .returns<{ job_id: string }[]>();
  if (assignmentsRes.error) {
    outcome.errors.push(`reading job_assignments: ${assignmentsRes.error.message}`);
    return outcome;
  }
  const jobIds = [...new Set((assignmentsRes.data ?? []).map((r) => r.job_id))];
  if (jobIds.length) {
    const jobsRes = await sb
      .from('jobs')
      .select('id, property_id')
      .in('id', jobIds)
      .returns<{ id: string; property_id: string | null }[]>();
    if (jobsRes.error) {
      outcome.errors.push(`reading jobs: ${jobsRes.error.message}`);
      return outcome;
    }
    const propertyIds = (jobsRes.data ?? [])
      .map((j) => j.property_id)
      .filter((p): p is string => !!p);
    const propsRes = propertyIds.length
      ? await sb
          .from('properties')
          .select('id, lat, lng')
          .in('id', propertyIds)
          .returns<{ id: string; lat: number | null; lng: number | null }[]>()
      : { data: [] as { id: string; lat: number | null; lng: number | null }[], error: null };
    if (propsRes.error) {
      outcome.errors.push(`reading properties: ${propsRes.error.message}`);
      return outcome;
    }
    const coords = new Map((propsRes.data ?? []).map((p) => [p.id, p]));
    for (const job of jobsRes.data ?? []) {
      const c = job.property_id ? coords.get(job.property_id) : undefined;
      // The schedule gate makes this unreachable for new assignments; belt and
      // braces for anything assigned before the gate shipped.
      if (c && c.lat != null && c.lng != null) {
        places.push({ kind: 'job', jobId: job.id, lat: c.lat, lng: c.lng });
      }
    }
  }

  for (const vehicle of vehicles) {
    const report = byImei.get(vehicle.imei);
    const loc = report?.stats?.location;
    const lastUpdated = report?.stats?.lastUpdated ? Date.parse(report.stats.lastUpdated) : NaN;
    const fresh =
      Number.isFinite(lastUpdated) && now.getTime() - lastUpdated <= STALE_POSITION_MINUTES * 60_000;

    // Always record what Bouncie told us, INCLUDING the staleness: last_seen_at
    // is Bouncie's own timestamp, so the map can honestly show "no signal since
    // 9:14" instead of a confident stale dot.
    if (loc?.lat != null && loc?.lon != null && Number.isFinite(lastUpdated)) {
      const { error } = await sb
        .from('vehicles')
        .update({
          last_lat: loc.lat,
          last_lng: loc.lon, // Bouncie says lon; our columns say lng. One seam.
          last_seen_at: new Date(lastUpdated).toISOString(),
        })
        .eq('id', vehicle.id);
      if (error) outcome.errors.push(`updating ${vehicle.label}: ${error.message}`);
    }

    if (!loc || loc.lat == null || loc.lon == null || !fresh) {
      // No signal is a first-class state, not an error. Crucially it does NOT
      // close an open visit: a van whose device fell silent at a job has not
      // left the job, and closing on silence would write a wrong departure.
      outcome.noSignal += 1;
      continue;
    }
    outcome.polled += 1;

    const position = { lat: loc.lat, lng: loc.lon };
    const here = resolvePlace(position, places);

    const openRes = await sb
      .from('vehicle_visits')
      .select('id, kind, job_id, entered_at')
      .eq('vehicle_id', vehicle.id)
      .is('exited_at', null)
      .limit(1)
      .returns<{ id: string; kind: string; job_id: string | null; entered_at: string }[]>();
    if (openRes.error) {
      outcome.errors.push(`reading open visit for ${vehicle.label}: ${openRes.error.message}`);
      continue;
    }
    const open = openRes.data?.[0] ?? null;
    const samePlace = open && here && open.kind === here.kind && open.job_id === here.jobId;

    if (open && !samePlace) {
      // Left the place (or moved to a different one). Close, applying the
      // 15-minute rule at close time: dwell below the threshold is recorded and
      // flagged, never discarded.
      const dwellMinutes = (now.getTime() - Date.parse(open.entered_at)) / 60_000;
      const { error } = await sb
        .from('vehicle_visits')
        .update({
          exited_at: now.toISOString(),
          below_min_dwell: dwellMinutes < MIN_DWELL_MINUTES,
        })
        .eq('id', open.id)
        .is('exited_at', null);
      if (error) outcome.errors.push(`closing visit for ${vehicle.label}: ${error.message}`);
      else outcome.closed += 1;
    }

    if (here && !samePlace) {
      const { error } = await sb.from('vehicle_visits').insert({
        vehicle_id: vehicle.id,
        kind: here.kind,
        job_id: here.jobId,
        entered_at: now.toISOString(),
        entered_lat: position.lat,
        entered_lng: position.lng,
      });
      if (error) outcome.errors.push(`opening visit for ${vehicle.label}: ${error.message}`);
      else outcome.opened += 1;
    }
  }

  return outcome;
}
