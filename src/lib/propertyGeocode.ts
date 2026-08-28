// src/lib/propertyGeocode.ts — write-site geocoding for property coordinates
// (ledger row 403 constraint (e), made real; Naldo's ask 2026-08-27: "every time
// a job is made, you should go ahead and grab those coordinates").
//
// THE RULE THIS ENFORCES. A coordinate only lands in `properties.lat/lng` when
// it passes the geofence-anchor gate: ROOFTOP, real street address, no fuzzy
// match, inside the service area. Everything else stays NULL. The phase-1
// backfill proved why with live data: Google silently returns wrong-town and
// wrong-state answers that look perfectly precise — five out of five
// RANGE_INTERPOLATED hits resolved to a different town, and one address
// resolved to Missouri.
//
// NULL is a safe state (the job cannot be scheduled until it is fixed, and the
// fix-list surfaces it). A confident wrong coordinate is not: it becomes a
// proximity anchor, and a van "arrives" at a house it was never near.
//
// BEST-EFFORT, NEVER FATAL. Geocoding rides inside hot paths (quote save →
// findOrCreateProperty). A Google outage must degrade to "no coordinate yet",
// never to a failed quote save.

import { geocodeAddress, isGoogleMapsConfigured } from '@/lib/googleMaps';
import { geofenceAnchorRefusal } from '@/lib/geofenceAnchor';

export type GeocodeAttempt =
  | { ok: true; lat: number; lng: number }
  | { ok: false; reason: string };

/**
 * Geocode an address and gate the result to anchor precision.
 *
 * Returns a refusal reason rather than throwing: the callers treat "could not
 * verify" as a normal outcome, and the reason is what the fix-list shows a
 * human.
 */
export async function verifiedCoordsForAddress(address: string): Promise<GeocodeAttempt> {
  if (!address.trim()) return { ok: false, reason: 'no address' };
  if (!isGoogleMapsConfigured()) return { ok: false, reason: 'geocoding not configured' };
  try {
    const geo = await geocodeAddress(address);
    const refusal = geofenceAnchorRefusal(geo);
    if (refusal) return { ok: false, reason: refusal };
    return { ok: true, lat: geo.lat, lng: geo.lng };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
