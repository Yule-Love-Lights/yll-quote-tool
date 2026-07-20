// Service-area gate for the customer self-serve estimate (Phase A, slice 2a).
//
// YLL serves Nassau + Suffolk counties (Long Island, NY). The public estimator
// must not quote a home we don't service — so /api/estimate geocodes the address
// FIRST and, if it isn't in the served area, stops before spending the analyzer
// call and returns served:false (the page then shows a clear "we don't cover
// that area yet" and still lets the customer leave their info for expansion).
//
// Gated on the geocoded COUNTY + STATE (not ZIP prefixes): Long Island ZIP
// ranges bleed into Queens (NYC), so "Nassau County / Suffolk County in New
// York" is the precise, edge-case-free definition. Keep the list here as the
// single source of truth — adding a county is a one-line change.

const SERVED_STATE = 'new york';
const SERVED_COUNTIES = ['nassau county', 'suffolk county'];

function normalize(v: string | undefined | null): string {
  return (v ?? '').trim().toLowerCase();
}

/**
 * True when a geocoded county + state is inside YLL's service area. Tolerant of
 * a missing "County" suffix (Google usually includes it, but normalize either
 * way) and case. A missing county or state is NOT served — we never quote an
 * address we can't confidently place.
 */
export function isServedArea(county: string | undefined | null, state: string | undefined | null): boolean {
  const s = normalize(state);
  if (s !== SERVED_STATE) return false;
  const c = normalize(county);
  if (!c) return false;
  const withSuffix = c.endsWith(' county') ? c : `${c} county`;
  return SERVED_COUNTIES.includes(withSuffix);
}

// Google's precision levels that mean "we located an actual building". ROOFTOP
// is an exact structure; RANGE_INTERPOLATED is a point interpolated between two
// known house numbers on the street — close enough to image the right house.
// GEOMETRIC_CENTER (street/polygon midpoint) and APPROXIMATE (town/ZIP centroid)
// are NOT.
const PRECISE_LOCATION_TYPES = ['ROOFTOP', 'RANGE_INTERPOLATED'];

/**
 * True when a geocode actually resolved to a specific HOME, not a town/ZIP
 * centroid.
 *
 * Found by the first live smoke (2026-07-20): an unresolvable street ("6 Birds
 * Rose, Amityville NY") does NOT error — Google silently returns the TOWN
 * centroid with location_type 'APPROXIMATE', partial_match true, types
 * ['locality','political'] and no street_number, but WITH a valid county
 * ("Suffolk County"). That sailed through isServedArea, so we imaged the middle
 * of Amityville, measured whatever building sat there, and showed the customer a
 * confident price for a house we never located. Quoting an unlocated building is
 * a money bug, so the estimator now requires a precise hit and otherwise asks the
 * customer to check their address.
 */
export function isPreciseAddress(geo: {
  locationType?: string;
  partialMatch?: boolean;
  hasStreetAddress?: boolean;
}): boolean {
  if (geo.partialMatch === true) return false;
  if (!geo.hasStreetAddress) return false;
  return PRECISE_LOCATION_TYPES.includes((geo.locationType ?? '').trim().toUpperCase());
}
