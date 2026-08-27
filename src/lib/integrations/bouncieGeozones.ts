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
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    // Catches a lat/lng swap at the caller before it becomes a zone that never
    // fires: a longitude in the latitude slot is out of range surprisingly often.
    throw new BouncieGeozoneError(`Coordinate out of range (lat ${lat}, lng ${lng}).`);
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
};

type ScheduledRow = {
  job_id: string;
  jobs: { property_id: string | null; properties: { lat: number | null; lng: number | null } | null } | null;
};

/**
 * Arm geofences for every job scheduled on `date`.
 *
 * Idempotent by the partial unique index on (job_id, assigned_date) where not
 * retired: a job already armed for that date is skipped rather than
 * double-registered, so re-running after a partial failure is safe.
 *
 * A job whose property has no coordinate is SKIPPED, not guessed at. The phase-1
 * backfill deliberately refused imprecise geocodes, and inventing a geofence
 * around a town centroid would make every van driving through town look like it
 * arrived — the exact failure that refusal exists to prevent.
 */
export async function armZonesForDate(date: string): Promise<ArmResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new BouncieGeozoneError('No Supabase service client.');
  const result: ArmResult = { armed: 0, skipped: [], failed: [] };

  const { data: vehicles } = await sb
    .from('vehicles')
    .select('id, imei, label')
    .eq('active', true)
    .not('imei', 'is', null)
    .returns<{ id: string; imei: string; label: string }[]>();
  if (!vehicles?.length) return result;

  const { data: assignments } = await sb
    .from('job_assignments')
    .select('job_id, jobs(property_id, properties(lat, lng))')
    .eq('assigned_date', date)
    .returns<ScheduledRow[]>();

  // One zone set per JOB, not per assignment: several crew on one job is normal
  // and must not produce several identical geofences.
  const seen = new Set<string>();
  for (const row of assignments ?? []) {
    if (seen.has(row.job_id)) continue;
    seen.add(row.job_id);

    const coords = row.jobs?.properties;
    if (!coords || coords.lat == null || coords.lng == null) {
      result.skipped.push({ jobId: row.job_id, reason: 'property has no verified coordinate' });
      continue;
    }

    const { data: existing } = await sb
      .from('job_geozones')
      .select('id')
      .eq('job_id', row.job_id)
      .eq('assigned_date', date)
      .is('retired_at', null)
      .returns<{ id: string }[]>();
    if (existing?.length) {
      result.skipped.push({ jobId: row.job_id, reason: 'already armed' });
      continue;
    }

    try {
      const locationId = await createLocation(`job-${row.job_id}-${date}`, buildCircle(coords.lat, coords.lng));
      for (const vehicle of vehicles) {
        const geozoneId = await createGeozone(vehicle.imei, locationId);
        const { error } = await sb.from('job_geozones').insert({
          kind: 'job',
          job_id: row.job_id,
          assigned_date: date,
          bouncie_location_id: locationId,
          bouncie_geozone_id: geozoneId,
        });
        if (error) throw new BouncieGeozoneError(error.message);
        result.armed += 1;
      }
    } catch (err) {
      result.failed.push({ jobId: row.job_id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
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
