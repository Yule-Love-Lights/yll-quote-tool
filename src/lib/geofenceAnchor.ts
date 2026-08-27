// Geofence-anchor precision gate (ledger row 403, phase 1).
//
// A geofence asks "is the van within N metres of THIS house". That is a far
// stricter bar than any other use of a geocode in this app, so it gets its own
// gate rather than reusing the estimator's `isPreciseAddress`.
//
// WHY IT IS STRICTER THAN THE ESTIMATOR'S GATE. `isPreciseAddress` in
// `selfServe/serviceArea.ts` accepts RANGE_INTERPOLATED, and for its job that is
// correct: an interpolated point on the right street is close enough to photograph
// the right house. It is NOT close enough to anchor a geofence, and the 2026-08-25
// backfill dry run over the real `properties` table proved it. Every one of the
// five RANGE_INTERPOLATED hits in that run resolved to a DIFFERENT TOWN than the
// address named, with `partial_match` false so nothing flagged it:
//
//   "30 Wagon Ln, Smithtown, NY 11787"   -> 30 Wagon Ln S, Centereach, NY 11720
//   "42 Lincoln Ave, Smithtown, NY 11787" -> 42 Lincoln Ave, Nesconset, NY 11767
//   "123 Main St, Smithtown, NY 11787"    -> 123 Main St, Kings Park, NY 11754
//
// Five for five. So this gate takes ROOFTOP only.
//
// WHY THE SERVICE-AREA CHECK IS PART OF THE PRECISION GATE. The same dry run
// found "7 COUNTRY LAKE CT" (a row with no town or state stored at all) resolving
// to St Peters, MISSOURI — ROOFTOP-adjacent precision, real street number, real
// route, `partial_match` false. It passed every shape-based check cleanly, because
// nothing was malformed: Google answered a different question well. A gate that
// only validates the SHAPE of Google's answer cannot catch that; it takes a
// plausibility check. `isServedArea` already encodes exactly the right one, so
// this reuses it rather than inventing a bounding box.
//
// WHERE THIS BELONGS. Row 403 constraint (e): the guard has to live at the WRITE,
// not only in the one script that happens to do it correctly today.
// `findOrCreateProperty`'s `geo` parameter is newest-wins and ungated, so any
// future caller that wires a geocode through must call this first.

import { isServedArea } from './selfServe/serviceArea';

/**
 * The only Google `location_type` precise enough to anchor a geofence to one
 * house. Deliberately excludes RANGE_INTERPOLATED — see the file header.
 */
const GEOFENCE_LOCATION_TYPES = ['ROOFTOP'];

export type GeofenceAnchorCandidate = {
  locationType?: string;
  partialMatch?: boolean;
  hasStreetAddress?: boolean;
  county?: string;
  state?: string;
};

/**
 * Returns a human-readable reason to REFUSE this geocode as a geofence anchor,
 * or `null` when it is precise enough to store.
 *
 * Refusing is the safe outcome: a refused row keeps `lat`/`lng` NULL, which every
 * consumer already treats as "no coordinate". Storing a confident-looking wrong
 * coordinate is the failure this exists to prevent, because once phase 4 turns
 * arrivals into suggestions, a bad anchor prompts a crew to clock onto a job they
 * are nowhere near.
 */
export function geofenceAnchorRefusal(geo: GeofenceAnchorCandidate): string | null {
  if (geo.partialMatch === true) return 'partial_match (Google fuzzy-matched the address)';
  if (geo.hasStreetAddress !== true) return 'no street_number+route (resolved to an area, not a house)';

  const locationType = (geo.locationType ?? '').trim().toUpperCase();
  if (!GEOFENCE_LOCATION_TYPES.includes(locationType)) {
    return `location_type ${geo.locationType ?? 'unknown'} (not a confirmed rooftop)`;
  }

  // Plausibility, not shape. A precise hit for the wrong region is still wrong.
  if (!isServedArea(geo.county, geo.state)) {
    const where = [geo.county, geo.state].filter(Boolean).join(', ') || 'unknown location';
    return `outside the service area (${where}) — precise, but not a house we serve`;
  }

  return null;
}
