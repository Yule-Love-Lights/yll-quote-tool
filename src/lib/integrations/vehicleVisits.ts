// src/lib/integrations/vehicleVisits.ts
// Turns Bouncie geofence events into the GPS visit timeline (row 403, phase 3b).
//
// THE SECOND CLOCK. Naldo's design, 2026-08-27: the crew keep clocking in and
// out by hand and that stays the payroll record; this is an independent record
// of the same day, derived from where the vans actually were, so the two can be
// compared. "How long did that job really take" and "did they double back" are
// the questions it exists to answer.
//
// ROW 403 CONSTRAINT (a): GPS NEVER WRITES PAYROLL. Nothing in this file imports
// or touches `shifts`, `job_segments`, or the clock-in routes, and the tables it
// writes have no foreign key into any of them. If a future change makes that
// untrue, the constraint has been broken regardless of what any comment says.
//
// BEST-EFFORT BY DESIGN. Every function here is called AFTER the raw event has
// already been stored, and callers are expected to swallow failures. Deriving a
// visit must never be able to fail the capture: the raw event is the source of
// truth and can always be reprocessed, whereas a webhook we answer with an error
// gets retried and eventually deactivated by Bouncie.

import { getSupabaseServiceClient } from '@/lib/supabase';

export type GeozoneEventFacts = {
  /** Bouncie's own zone id, which is what the event carries. */
  bouncieGeozoneId: string;
  /** ENTER or EXIT. Anything else is ignored rather than guessed at. */
  direction: 'ENTER' | 'EXIT';
  imei: string;
  occurredAt: string;
  /** The `vehicle_events` row this was derived from. */
  eventId: string;
};

/**
 * Pull the geofence facts out of a raw payload, tolerantly.
 *
 * Returns null when this is not a usable geozone event — a different event type,
 * a missing zone id, an unrecognised direction. Null means "nothing to derive",
 * not "something went wrong".
 */
export function parseGeozoneEvent(
  payload: unknown,
  eventId: string,
  occurredAt: string | null,
): GeozoneEventFacts | null {
  if (!payload || typeof payload !== 'object') return null;
  const b = payload as Record<string, unknown>;
  const type = typeof b.eventType === 'string' ? b.eventType : '';
  if (type !== 'applicationGeozone' && type !== 'userGeozone') return null;

  const zone = b.geozone && typeof b.geozone === 'object' ? (b.geozone as Record<string, unknown>) : null;
  const bouncieGeozoneId = typeof zone?.id === 'string' ? zone.id.trim() : '';
  const rawDirection = typeof zone?.event === 'string' ? zone.event.trim().toUpperCase() : '';
  const imei = typeof b.imei === 'string' ? b.imei.trim() : '';

  if (!bouncieGeozoneId || !imei) return null;
  if (rawDirection !== 'ENTER' && rawDirection !== 'EXIT') return null;

  // Prefer the zone's own timestamp; fall back to what the receiver already
  // parsed. One of them being absent is not a reason to drop a real arrival.
  const zoneTime = typeof zone?.timestamp === 'string' ? zone.timestamp : '';
  const when = zoneTime || occurredAt || '';
  const parsed = when ? Date.parse(when) : NaN;
  if (Number.isNaN(parsed)) return null;

  return {
    bouncieGeozoneId,
    direction: rawDirection,
    imei,
    occurredAt: new Date(parsed).toISOString(),
    eventId,
  };
}

export type VisitOutcome =
  | { action: 'opened'; visitId: string }
  | { action: 'closed'; visitId: string }
  | { action: 'ignored'; reason: string };

/**
 * Record one geofence event as a visit.
 *
 * ENTER opens a visit; EXIT closes the most recent open one for that vehicle and
 * zone. Every "ignored" outcome names its reason, because the difference between
 * "we do not track that zone" and "no matching arrival" matters when someone is
 * working out why a job has no timeline.
 */
export async function recordGeozoneVisit(facts: GeozoneEventFacts): Promise<VisitOutcome> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { action: 'ignored', reason: 'no service client' };

  // Which of our zones is this? An unknown zone is normal — a zone we retired,
  // or one the vehicle owner created themselves in the Bouncie app.
  const { data: zones } = await sb
    .from('job_geozones')
    .select('id, kind, job_id')
    .eq('bouncie_geozone_id', facts.bouncieGeozoneId)
    .limit(1)
    .returns<{ id: string; kind: 'job' | 'depot'; job_id: string | null }[]>();
  const zone = zones?.[0];
  if (!zone) return { action: 'ignored', reason: 'unknown geozone' };

  // Which vehicle? The device is the identity, per row 403 constraint (c).
  const { data: vehicles } = await sb
    .from('vehicles')
    .select('id')
    .eq('imei', facts.imei)
    .limit(1)
    .returns<{ id: string }[]>();
  const vehicle = vehicles?.[0];
  if (!vehicle) return { action: 'ignored', reason: 'unregistered vehicle' };

  if (facts.direction === 'ENTER') {
    const { data, error } = await sb
      .from('vehicle_visits')
      .insert({
        vehicle_id: vehicle.id,
        geozone_id: zone.id,
        kind: zone.kind,
        job_id: zone.job_id,
        entered_at: facts.occurredAt,
        enter_event_id: facts.eventId,
      })
      .select('id')
      .returns<{ id: string }[]>();

    if (error) {
      // 23505 on enter_event_id: this exact ENTER was already recorded. Bouncie
      // documents duplicate delivery as normal, so this is a success.
      if (error.code === '23505') return { action: 'ignored', reason: 'duplicate enter' };
      return { action: 'ignored', reason: `insert failed: ${error.message}` };
    }
    return { action: 'opened', visitId: data![0]!.id };
  }

  // EXIT: close the most recent still-open visit for this vehicle and zone.
  const { data: open } = await sb
    .from('vehicle_visits')
    .select('id')
    .eq('vehicle_id', vehicle.id)
    .eq('geozone_id', zone.id)
    .is('exited_at', null)
    .order('entered_at', { ascending: false })
    .limit(1)
    .returns<{ id: string }[]>();
  const visit = open?.[0];

  // An EXIT with no matching arrival is genuinely possible — the zone may have
  // been armed while the van was already inside it. Recording a visit with no
  // entry time would invent a duration, so this is dropped rather than guessed.
  if (!visit) return { action: 'ignored', reason: 'exit without an open visit' };

  const { error } = await sb
    .from('vehicle_visits')
    .update({ exited_at: facts.occurredAt, exit_event_id: facts.eventId })
    .eq('id', visit.id)
    .is('exited_at', null); // lost-race guard: another delivery may have closed it
  if (error) return { action: 'ignored', reason: `update failed: ${error.message}` };

  return { action: 'closed', visitId: visit.id };
}
