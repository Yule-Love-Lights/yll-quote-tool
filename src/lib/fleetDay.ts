// src/lib/fleetDay.ts — one day of the fleet, assembled for the office
// (ledger row 403; the compare view and the map's data).
//
// THE TWO CLOCKS, SIDE BY SIDE AND NEVER MERGED. The left column is the crew's
// own clock (`shifts`, the payroll record, untouched). The right column is the
// GPS timeline (`vehicle_visits`). This module READS both and writes neither —
// comparing is the entire point, and a disagreement between them is information
// to investigate, not an error to reconcile automatically.
//
// OFFICE ONLY (Naldo, 2026-08-27). The page that renders this sits behind the
// operator session like the rest of /admin; crew do not see it.
//
// THE VAN IS NOT THE PERSON, and every consumer of this data needs that
// sentence. A crew member can be working after the van leaves; a van can sit
// somewhere while nobody works; two crew share one van. The GPS column says
// where the VEHICLE was, nothing more.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { MIN_DWELL_MINUTES, STALE_POSITION_MINUTES } from '@/lib/integrations/vehicleProximity';
import { etMidnightAfter, addDays } from '@/lib/opsMidnightClose';

export type FleetVehicleNow = {
  id: string;
  label: string;
  lastLat: number | null;
  lastLng: number | null;
  lastSeenAt: string | null;
  /** Explicit, so the UI can never render a stale dot as a live one. */
  signal: 'live' | 'stale' | 'never';
};

export type FleetVisit = {
  vehicleLabel: string;
  /** The vehicle's CURRENT signal, so an open "still there" row can say
   * "no signal since <t>" instead of implying the crew is still working. */
  vehicleSignal: 'live' | 'stale' | 'never';
  vehicleLastSeenAt: string | null;
  kind: 'job' | 'depot';
  jobNumber: number | null;
  address: string | null;
  enteredAt: string;
  exitedAt: string | null;
  minutes: number | null;
  belowMinDwell: boolean | null;
};

export type FleetShift = {
  crewName: string;
  clockInAt: string;
  clockOutAt: string | null;
};

export type FleetDay = {
  vehicles: FleetVehicleNow[];
  visits: FleetVisit[];
  shifts: FleetShift[];
  errors: string[];
};

export async function loadFleetDay(date: string): Promise<FleetDay> {
  const out: FleetDay = { vehicles: [], visits: [], shifts: [], errors: [] };
  const sb = getSupabaseServiceClient();
  if (!sb) {
    out.errors.push('no service client');
    return out;
  }
  // The ET day, DST-correct. A hardcoded T04:00Z is right in summer and wrong
  // by an hour all winter — this repo's row-335 class, and the S68 lens round
  // caught this file repeating it. etMidnightAfter converges on the offset
  // actually in force, so midnight means midnight in March and November too.
  const start = etMidnightAfter(new Date(`${addDays(date, -1)}T12:00:00Z`)).toISOString();
  const endDate = etMidnightAfter(new Date(`${date}T12:00:00Z`)).toISOString();

  const vehiclesRes = await sb
    .from('vehicles')
    .select('id, label, last_lat, last_lng, last_seen_at')
    .eq('active', true)
    .order('label')
    .returns<{ id: string; label: string; last_lat: number | null; last_lng: number | null; last_seen_at: string | null }[]>();
  if (vehiclesRes.error) out.errors.push(`vehicles: ${vehiclesRes.error.message}`);
  const now = Date.now();
  const labelById = new Map<string, string>();
  const signalById = new Map<string, { signal: 'live' | 'stale' | 'never'; lastSeenAt: string | null }>();
  for (const v of vehiclesRes.data ?? []) {
    labelById.set(v.id, v.label);
    const signal: 'live' | 'stale' | 'never' = !v.last_seen_at
      ? 'never'
      : now - Date.parse(v.last_seen_at) <= STALE_POSITION_MINUTES * 60_000
        ? 'live'
        : 'stale';
    signalById.set(v.id, { signal, lastSeenAt: v.last_seen_at });
    out.vehicles.push({
      id: v.id,
      label: v.label,
      lastLat: v.last_lat,
      lastLng: v.last_lng,
      lastSeenAt: v.last_seen_at,
      signal,
    });
  }

  const visitsRes = await sb
    .from('vehicle_visits')
    .select('vehicle_id, kind, job_id, entered_at, exited_at, below_min_dwell')
    .gte('entered_at', start)
    .lt('entered_at', endDate)
    .order('entered_at')
    .returns<{ vehicle_id: string; kind: 'job' | 'depot'; job_id: string | null; entered_at: string; exited_at: string | null; below_min_dwell: boolean | null }[]>();
  if (visitsRes.error) out.errors.push(`visits: ${visitsRes.error.message}`);
  const visitRows = visitsRes.data ?? [];

  // Job labels: number + address, resolved without a nested embed (jobs has no
  // FK to properties — learned the hard way in S68).
  const jobIds = [...new Set(visitRows.map((v) => v.job_id).filter((j): j is string => !!j))];
  const jobLabel = new Map<string, { jobNumber: number | null; address: string | null }>();
  if (jobIds.length) {
    const jobsRes = await sb
      .from('jobs')
      .select('id, job_number, property_id')
      .in('id', jobIds)
      .returns<{ id: string; job_number: number | null; property_id: string | null }[]>();
    if (jobsRes.error) out.errors.push(`jobs: ${jobsRes.error.message}`);
    const propIds = [...new Set((jobsRes.data ?? []).map((j) => j.property_id).filter((p): p is string => !!p))];
    const addr = new Map<string, string | null>();
    if (propIds.length) {
      const propsRes = await sb
        .from('properties')
        .select('id, address')
        .in('id', propIds)
        .returns<{ id: string; address: string | null }[]>();
      if (propsRes.error) out.errors.push(`properties: ${propsRes.error.message}`);
      for (const p of propsRes.data ?? []) addr.set(p.id, p.address);
    }
    for (const j of jobsRes.data ?? []) {
      jobLabel.set(j.id, {
        jobNumber: j.job_number,
        address: j.property_id ? (addr.get(j.property_id) ?? null) : null,
      });
    }
  }

  for (const v of visitRows) {
    const label = v.job_id ? jobLabel.get(v.job_id) : undefined;
    const sig = signalById.get(v.vehicle_id);
    out.visits.push({
      vehicleLabel: labelById.get(v.vehicle_id) ?? '(unknown vehicle)',
      vehicleSignal: sig?.signal ?? 'never',
      vehicleLastSeenAt: sig?.lastSeenAt ?? null,
      kind: v.kind,
      jobNumber: label?.jobNumber ?? null,
      address: v.kind === 'depot' ? 'Depot' : (label?.address ?? null),
      enteredAt: v.entered_at,
      exitedAt: v.exited_at,
      minutes: v.exited_at ? Math.round((Date.parse(v.exited_at) - Date.parse(v.entered_at)) / 60_000) : null,
      belowMinDwell: v.below_min_dwell,
    });
  }

  // The manual clock, same day window. Read-only; this is the payroll record.
  const shiftsRes = await sb
    .from('shifts')
    .select('crew_member_id, clock_in_at, clock_out_at')
    .gte('clock_in_at', start)
    .lt('clock_in_at', endDate)
    .order('clock_in_at')
    .returns<{ crew_member_id: string; clock_in_at: string; clock_out_at: string | null }[]>();
  if (shiftsRes.error) out.errors.push(`shifts: ${shiftsRes.error.message}`);
  const shiftRows = shiftsRes.data ?? [];
  const crewIds = [...new Set(shiftRows.map((s) => s.crew_member_id))];
  const crewName = new Map<string, string>();
  if (crewIds.length) {
    const crewRes = await sb
      .from('crew_members')
      .select('id, display_name')
      .in('id', crewIds)
      .returns<{ id: string; display_name: string }[]>();
    if (crewRes.error) out.errors.push(`crew_members: ${crewRes.error.message}`);
    for (const c of crewRes.data ?? []) crewName.set(c.id, c.display_name);
  }
  for (const s of shiftRows) {
    out.shifts.push({
      crewName: crewName.get(s.crew_member_id) ?? '(unknown)',
      clockInAt: s.clock_in_at,
      clockOutAt: s.clock_out_at,
    });
  }

  return out;
}

export { MIN_DWELL_MINUTES };
