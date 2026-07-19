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
