// src/lib/integrations/bouncieGeozones.ts
// Creating and retiring Bouncie geofences (ledger row 403, phase 3c).
//
// WHY BOUNCIE'S GEOFENCES RATHER THAN OUR OWN. Row 403 originally assumed we
// would compute "is the van near this house" ourselves from a position stream.
// Bouncie does it server-side: we register a circle, and it POSTs us ENTER and
// EXIT. That is strictly better here. It needs no continuous position feed (we
// deliberately turned `tripData` off, since Bouncie documents it as the bulk of
// webhook volume), and their Application Geo-Zones are invisible in the vehicle
// owner's own Bouncie app, so this does not clutter what Naldo sees personally.
//
// TWO VENDOR DETAILS THAT ARE EASY TO GET WRONG, both confirmed from the spec:
//
//   1. COORDINATES ARE [longitude, latitude], in that order. Our `properties`
//      table stores lat and lng as separate columns and every other part of this
//      codebase says "lat, lng". Swapping them produces a geofence in the wrong
//      hemisphere that simply never fires, with no error anywhere. Tested.
//
//   2. A GEOZONE IS PER-DEVICE. `POST /v1/application-geozones` takes an `imei`,
//      so a job site watched by two vehicles needs two zones over one location.
//      This is why arming a day is (jobs x active vehicles), not just jobs.
//
// ARMED ONLY ON DAYS WITH WORK. Naldo's rule, 2026-08-27: zones exist for a day
// that has scheduled jobs and are retired afterwards. That keeps the geofence
// count small and, not incidentally, means the vans are not being watched
// against customer addresses on days nobody is working.

import { bouncieFetch } from '@/lib/integrations/bouncieAuth';
import { getSupabaseServiceClient } from '@/lib/supabase';

/**
 * Geofence radius, in metres.
 *
 * This is the single most consequential number in the whole feature and it is
 * currently a considered guess, not a measured value.
 *
 * Too small and a van parked three houses down never registers as arriving. Too
 * large and simply driving past on the road counts as a visit. 120m is roughly a
 * few house-widths on a Long Island residential street: generous enough to cover
 * parking near the property, tight enough that a van on a parallel street does
 * not trigger it.
 *
 * It cannot be tuned honestly until real arrivals can be compared against real
 * jobs. Expect to change it, and change it HERE — nothing else should hard-code
 * a radius.
 */
export const GEOFENCE_RADIUS_METRES = 120;

/**
 * The box every real job site of ours falls inside.
 *
 * WHY A RANGE CHECK IS NOT ENOUGH. `lat` must be within ±90 and `lng` within
 * ±180, so a swap only trips that guard when one value happens to exceed 90.
 * This company works on Long Island: latitude around 40.7, longitude around
 * -73.4. Swap those and you get lat -73.4, lng 40.7 — and -73.4 is a perfectly
 * legal latitude. The zone lands in the South Atlantic and simply never fires,
 * with no error anywhere. The S68 technical lens caught that the original guard
 * structurally could not catch this, and the test conceded it.
 *
 * So the check is not "is this a valid coordinate" but "is this OUR coordinate".
 * Same lesson as the phase-1 backfill: a precise answer to the wrong question
 * still passes every shape-based test.
 *
 * Generous on purpose — it covers Long Island, the five boroughs and a margin —
 * because its job is catching gross errors, not enforcing the service area.
 */
export const SERVICE_AREA_BOX = { minLat: 40.4, maxLat: 41.3, minLng: -74.3, maxLng: -71.7 } as const;

export class BouncieGeozoneError extends Error {}

type Circle = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { subType: 'Circle'; radius: number };
};

/**
 * A circular geofence around one coordinate.
 *
 * Note the argument order versus the output order: this takes (lat, lng) because
 * that is how the rest of this codebase and the `properties` table speak, and
 * emits [lng, lat] because that is what GeoJSON and Bouncie require. Putting the
 * swap in exactly one function is the point.
 */
export function buildCircle(lat: number, lng: number, radiusMetres = GEOFENCE_RADIUS_METRES): Circle {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new BouncieGeozoneError('Cannot build a geofence without a real coordinate.');
  }
  const { minLat, maxLat, minLng, maxLng } = SERVICE_AREA_BOX;
  if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) {
    // Deliberately reports the values, since the overwhelmingly likely cause is
    // that they arrived the wrong way round.
    throw new BouncieGeozoneError(
      `Coordinate (lat ${lat}, lng ${lng}) is outside the service area box; check for a lat/lng swap.`,
    );
  }
  if (!(radiusMetres > 0)) throw new BouncieGeozoneError('Geofence radius must be positive.');
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { subType: 'Circle', radius: radiusMetres },
  };
}

async function expectJson(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new BouncieGeozoneError(`${what} failed (${res.status}).`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new BouncieGeozoneError(`${what} returned no JSON.`);
  return body;
}

/** Create a location and return Bouncie's id for it. */
export async function createLocation(name: string, circle: Circle): Promise<string> {
  const res = await bouncieFetch('/locations/', { method: 'POST', body: { name, location: circle } });
  const body = await expectJson(res, 'Creating a Bouncie location');
  const id =
    typeof body.id === 'string'
      ? body.id
      : typeof (body.location as Record<string, unknown> | undefined)?.id === 'string'
        ? ((body.location as Record<string, unknown>).id as string)
        : '';
  if (!id) throw new BouncieGeozoneError('Bouncie location response carried no id.');
  return id;
}

/** Create an ENTER/EXIT geozone for ONE device over an existing location. */
export async function createGeozone(imei: string, locationId: string): Promise<string> {
  const res = await bouncieFetch('/application-geozones/', {
    method: 'POST',
    body: { imei, locationId, events: ['ENTER', 'EXIT'] },
  });
  const body = await expectJson(res, 'Creating a Bouncie geozone');
  const id =
    typeof body.id === 'string'
      ? body.id
      : typeof (body.geozone as Record<string, unknown> | undefined)?.id === 'string'
        ? ((body.geozone as Record<string, unknown>).id as string)
        : '';
  if (!id) throw new BouncieGeozoneError('Bouncie geozone response carried no id.');
  return id;
}

/**
 * Remove a geozone and its location.
 *
 * Best-effort and deliberately forgiving of a 404: a zone we believe exists but
 * Bouncie has already dropped should still be marked retired on our side, or we
 * would retry it forever.
 */
export async function deleteGeozone(geozoneId: string, locationId: string): Promise<void> {
  const zone = await bouncieFetch(`/application-geozones/${geozoneId}`, { method: 'DELETE' });
  if (!zone.ok && zone.status !== 404) {
    throw new BouncieGeozoneError(`Deleting geozone ${geozoneId} failed (${zone.status}).`);
  }
  const loc = await bouncieFetch(`/locations/${locationId}`, { method: 'DELETE' });
  if (!loc.ok && loc.status !== 404) {
    throw new BouncieGeozoneError(`Deleting location ${locationId} failed (${loc.status}).`);
  }
}

export type ArmResult = {
  armed: number;
  skipped: { jobId: string; reason: string }[];
  failed: { jobId: string; reason: string }[];
  /** A read that failed outright. Non-empty means the run is not trustworthy. */
  errors: string[];
};

/**
 * Arm geofences for every job scheduled on `date`.
 *
 * WHY THIS READS IN THREE STEPS RATHER THAN ONE NESTED SELECT. The obvious
 * version is `.select('job_id, jobs(property_id, properties(lat,lng))')`. It does
 * not work: `jobs.property_id` has no foreign key to `properties`, so PostgREST
 * cannot infer the relationship and answers
 * `PGRST200 Could not find a relationship between 'jobs' and 'properties'`.
 * Verified against the real database on 2026-08-27, after the S68 technical lens
 * found the missing constraint by reading the migrations.
 *
 * The first draft also destructured only `data` and dropped `error`, so that
 * failure would have armed ZERO geofences while reporting a clean run — the
 * feature silently doing nothing, forever, with nothing to see. Every read below
 * checks its error and surfaces it.
 *
 * IDEMPOTENT PER VEHICLE, not per job. A geozone belongs to one device, so a job
 * armed for the first van and failed for the second must still be arm-able for
 * the second. Checking "is this job armed" marked it done forever and left that
 * van permanently unwatched at that job, which reads downstream as a crew that
 * never showed up.
 *
 * A job whose property has no verified coordinate is SKIPPED, not guessed at.
 * The phase-1 backfill deliberately refused imprecise geocodes, and a geofence
 * around a town centroid would make every van driving through town look like it
 * arrived — the exact failure that refusal prevents.
 */
export async function armZonesForDate(date: string): Promise<ArmResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new BouncieGeozoneError('No Supabase service client.');
  const result: ArmResult = { armed: 0, skipped: [], failed: [], errors: [] };

  const vehiclesRes = await sb
    .from('vehicles')
    .select('id, imei, label')
    .eq('active', true)
    .not('imei', 'is', null)
    .returns<{ id: string; imei: string; label: string }[]>();
  if (vehiclesRes.error) {
    result.errors.push(`reading vehicles: ${vehiclesRes.error.message}`);
    return result;
  }
  const vehicles = vehiclesRes.data ?? [];
  if (!vehicles.length) {
    result.errors.push('no active vehicle with a device is registered');
    return result;
  }

  const assignmentsRes = await sb
    .from('job_assignments')
    .select('job_id')
    .eq('assigned_date', date)
    .returns<{ job_id: string }[]>();
  if (assignmentsRes.error) {
    result.errors.push(`reading job_assignments: ${assignmentsRes.error.message}`);
    return result;
  }
  // One zone set per JOB: several crew on one job is normal and must not produce
  // several identical geofences.
  const jobIds = [...new Set((assignmentsRes.data ?? []).map((r) => r.job_id))];
  if (!jobIds.length) return result;

  const jobsRes = await sb
    .from('jobs')
    .select('id, property_id')
    .in('id', jobIds)
    .returns<{ id: string; property_id: string | null }[]>();
  if (jobsRes.error) {
    result.errors.push(`reading jobs: ${jobsRes.error.message}`);
    return result;
  }
  const propertyByJob = new Map((jobsRes.data ?? []).map((j) => [j.id, j.property_id]));

  const propertyIds = [...new Set([...propertyByJob.values()].filter((v): v is string => !!v))];
  const coordsById = new Map<string, { lat: number | null; lng: number | null }>();
  if (propertyIds.length) {
    const propsRes = await sb
      .from('properties')
      .select('id, lat, lng')
      .in('id', propertyIds)
      .returns<{ id: string; lat: number | null; lng: number | null }[]>();
    if (propsRes.error) {
      result.errors.push(`reading properties: ${propsRes.error.message}`);
      return result;
    }
    for (const row of propsRes.data ?? []) coordsById.set(row.id, { lat: row.lat, lng: row.lng });
  }

  // Which (job, vehicle) pairs are already armed for this date.
  const armedRes = await sb
    .from('job_geozones')
    .select('job_id, vehicle_id')
    .eq('assigned_date', date)
    .is('retired_at', null)
    .returns<{ job_id: string; vehicle_id: string | null }[]>();
  if (armedRes.error) {
    result.errors.push(`reading job_geozones: ${armedRes.error.message}`);
    return result;
  }
  const alreadyArmed = new Set((armedRes.data ?? []).map((r) => `${r.job_id}:${r.vehicle_id}`));

  for (const jobId of jobIds) {
    const propertyId = propertyByJob.get(jobId);
    const coords = propertyId ? coordsById.get(propertyId) : undefined;
    if (!coords || coords.lat == null || coords.lng == null) {
      result.skipped.push({ jobId, reason: 'property has no verified coordinate' });
      continue;
    }

    const needed = vehicles.filter((v) => !alreadyArmed.has(`${jobId}:${v.id}`));
    if (!needed.length) {
      result.skipped.push({ jobId, reason: 'already armed for every vehicle' });
      continue;
    }

    let locationId: string | null = null;
    try {
      locationId = await createLocation(`job-${jobId}-${date}`, buildCircle(coords.lat, coords.lng));
    } catch (err) {
      result.failed.push({ jobId, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const vehicle of needed) {
      try {
        const geozoneId = await createGeozone(vehicle.imei, locationId);
        const { error } = await sb.from('job_geozones').insert({
          kind: 'job',
          job_id: jobId,
          assigned_date: date,
          vehicle_id: vehicle.id,
          bouncie_location_id: locationId,
          bouncie_geozone_id: geozoneId,
        });
        if (error) {
          // The remote zone exists but we could not record it, so nothing will
          // ever retire it. Say so loudly: this is the leak shape, and it needs
          // a human to reconcile rather than a silent counter.
          result.failed.push({
            jobId,
            reason: `ORPHANED remote geozone ${geozoneId} (location ${locationId}) for ${vehicle.label}: ${error.message}`,
          });
          continue;
        }
        result.armed += 1;
      } catch (err) {
        result.failed.push({
          jobId,
          reason: `${vehicle.label}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Always say what happened. A night where arming failed for every job used to
  // look exactly like a night with nothing scheduled (S68 vendor + admin lenses).
  const summary = `[bouncie] arm ${date}: ${result.armed} armed, ${result.skipped.length} skipped, ${result.failed.length} failed, ${result.errors.length} errors`;
  if (result.errors.length || result.failed.length) console.error(summary, { errors: result.errors, failed: result.failed });
  else console.info(summary);

  return result;
}

/**
 * Find geozones that exist on Bouncie but not in our table.
 *
 * WHY THIS IS NEEDED AT ALL. Arming creates a remote resource and then records
 * it locally, and those two steps can come apart: an unhandled failure after the
 * create, a concurrent run losing the unique-index race, a database blip. When
 * they do, the zone exists in someone else's system and nothing here knows it
 * does, so nothing will ever delete it. The S68 vendor lens traced three such
 * paths and pointed out the real problem was not any one of them but that there
 * was no way to FIND the result afterwards.
 *
 * Read-only on purpose. It reports; a human decides. Deleting whatever we do not
 * recognise would be a fine way to remove a zone another application legitimately
 * created on the same account.
 */
export async function findOrphanedZones(): Promise<{ orphans: string[]; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { orphans: [], error: 'no service client' };

  let remote: unknown;
  try {
    const res = await bouncieFetch('/application-geozones/');
    if (!res.ok) return { orphans: [], error: `listing geozones failed (${res.status})` };
    remote = await res.json();
  } catch (err) {
    return { orphans: [], error: err instanceof Error ? err.message : String(err) };
  }

  const list = Array.isArray(remote)
    ? remote
    : Array.isArray((remote as Record<string, unknown> | null)?.geozones)
      ? ((remote as Record<string, unknown>).geozones as unknown[])
      : [];
  const remoteIds = list
    .map((z) => (z && typeof z === 'object' ? (z as Record<string, unknown>).id : null))
    .filter((id): id is string => typeof id === 'string');

  const { data, error } = await sb
    .from('job_geozones')
    .select('bouncie_geozone_id')
    .returns<{ bouncie_geozone_id: string }[]>();
  if (error) return { orphans: [], error: `reading job_geozones: ${error.message}` };

  const known = new Set((data ?? []).map((r) => r.bouncie_geozone_id));
  return { orphans: remoteIds.filter((id) => !known.has(id)) };
}

/**
 * Retire every job zone armed for a date before `before`.
 *
 * Marked retired on our side even when the remote delete fails, because a zone
 * we cannot delete is still a zone we should stop attributing visits to, and
 * leaving it live in our table would block re-arming the same job later.
 */
export async function retireZonesBefore(before: string): Promise<{ retired: number; failed: number }> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new BouncieGeozoneError('No Supabase service client.');

  const { data: stale } = await sb
    .from('job_geozones')
    .select('id, bouncie_geozone_id, bouncie_location_id')
    .eq('kind', 'job')
    .is('retired_at', null)
    .lt('assigned_date', before)
    .returns<{ id: string; bouncie_geozone_id: string; bouncie_location_id: string }[]>();

  let retired = 0;
  let failed = 0;
  for (const zone of stale ?? []) {
    try {
      await deleteGeozone(zone.bouncie_geozone_id, zone.bouncie_location_id);
    } catch (err) {
      failed += 1;
      console.warn('[bouncie] could not delete a remote geozone, retiring locally anyway:', err instanceof Error ? err.message : String(err));
    }
    await sb.from('job_geozones').update({ retired_at: new Date().toISOString() }).eq('id', zone.id);
    retired += 1;
  }
  return { retired, failed };
}
