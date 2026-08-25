// scripts/backfill-property-coords.ts — ONE-TIME backfill of properties.lat/lng
// (ledger row 403, phase 1 — the fleet-GPS groundwork).
//
// WHAT IT DOES. `properties` has had `lat`/`lng` columns since the customer-
// properties work, and NOTHING has ever filled them (measured 2026-08-25:
// 0 of 211 rows populated). Every later phase of the GPS integration needs a
// coordinate per job site, because a geofence is "is the van within N metres of
// THIS house". This script geocodes each un-populated address through the same
// `geocodeAddress()` the satellite analyzer already uses, and writes lat/lng.
//
// WHY IT REFUSES LOW-PRECISION HITS — the whole point of the script.
// Google does NOT fail on an address it cannot resolve; it silently returns the
// TOWN or ZIP centroid with a perfectly valid-looking lat/lng. For pricing that
// was an S47 near-miss (we nearly quoted a house we had never located). For a
// GEOFENCE it is worse than useless: a centroid puts the "driveway" in the
// middle of Hicksville, so every van that drives THROUGH town reads as having
// arrived at that job — and once phase 4 turns arrivals into suggestions, a
// crew gets prompted to clock onto a job they are nowhere near.
//
// So a row is only written when Google returns ALL of:
//   • location_type ROOFTOP or RANGE_INTERPOLATED (not APPROXIMATE/GEOMETRIC_CENTER)
//   • both street_number AND route  (`hasStreetAddress`)
//   • partial_match false
// Anything else is REFUSED and listed, so a human can fix the address instead of
// the system storing a confident-looking lie. A refused row keeps lat/lng NULL,
// which every consumer must already treat as "no coordinate".
//
// IDEMPOTENT / RESUMABLE. Only selects rows where lat IS NULL or lng IS NULL, so
// a re-run skips everything already written and simply retries the refusals.
// Safe to run repeatedly as addresses get cleaned up.
//
// SAFETY: writes NOTHING without --live, and --live REFUSES unless
// BACKFILL_CONSENT names today's UTC date (the named-consent gate for a prod
// data op, same as backfill-gml-threads.ts). The dry run prints the full
// accept/refuse breakdown; READ IT before consenting.
//
// COST: one Google Geocoding call per un-populated row (~211 today). Well inside
// the free tier, and serialised with a small delay rather than fired in parallel.
//
// USAGE:
//   npx tsx scripts/backfill-property-coords.ts                      # dry run
//   npx tsx scripts/backfill-property-coords.ts --limit=10           # dry run, first 10
//   BACKFILL_CONSENT=YYYY-MM-DD npx tsx scripts/backfill-property-coords.ts --live
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and GOOGLE_MAPS_API_KEY
// (.env.local).

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

import { geocodeAddress, isGoogleMapsConfigured } from '../src/lib/googleMaps';
import { getSupabaseServiceClient } from '../src/lib/supabase';

const LIVE = process.argv.includes('--live');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;

/** Google location_types precise enough to anchor a geofence to one house. */
const PRECISE_LOCATION_TYPES = new Set(['ROOFTOP', 'RANGE_INTERPOLATED']);

/** Pause between geocode calls — polite serial pacing, not a rate-limit dodge. */
const DELAY_MS = 120;

type PropertyRow = { id: string; address: string | null; lat: number | null; lng: number | null };

type Refusal = { id: string; address: string; reason: string };

function precisionRefusal(geo: {
  locationType?: string;
  partialMatch?: boolean;
  hasStreetAddress?: boolean;
}): string | null {
  if (geo.partialMatch === true) return 'partial_match (Google fuzzy-matched the address)';
  if (geo.hasStreetAddress !== true) return 'no street_number+route (resolved to an area, not a house)';
  if (!geo.locationType || !PRECISE_LOCATION_TYPES.has(geo.locationType)) {
    return `location_type ${geo.locationType ?? 'unknown'} (centroid, not a rooftop)`;
  }
  return null;
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  if (LIVE && process.env.BACKFILL_CONSENT !== today) {
    console.error(`REFUSED: --live requires BACKFILL_CONSENT=${today} (named consent, dated today).`);
    process.exit(1);
  }
  if (!isGoogleMapsConfigured()) {
    console.error('REFUSED: GOOGLE_MAPS_API_KEY is not configured (.env.local).');
    process.exit(1);
  }

  const sb = getSupabaseServiceClient();
  if (!sb) {
    console.error('REFUSED: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured (.env.local).');
    process.exit(1);
  }

  // Only un-populated rows. A row with coordinates is never re-geocoded, so a
  // re-run cannot move a coordinate that something downstream already trusts.
  let query = sb
    .from('properties')
    .select('id, address, lat, lng')
    .or('lat.is.null,lng.is.null')
    .order('created_at', { ascending: true });
  if (LIMIT != null) query = query.limit(LIMIT);

  const { data, error } = await query.returns<PropertyRow[]>();
  if (error) {
    console.error('REFUSED: could not read properties:', error.message);
    process.exit(1);
  }

  const rows = data ?? [];
  const blank = rows.filter((r) => !r.address?.trim());
  const todo = rows.filter((r) => !!r.address?.trim());

  console.log(`${LIVE ? 'LIVE' : 'DRY RUN'} — ${rows.length} properties without coordinates`);
  console.log(`  ${todo.length} have an address to geocode, ${blank.length} have no address at all\n`);

  let written = 0;
  let wouldWrite = 0;
  const refusals: Refusal[] = [];
  const failures: Refusal[] = [];

  for (const [i, row] of todo.entries()) {
    const address = row.address!.trim();
    const label = `[${i + 1}/${todo.length}] ${address}`;

    let geo;
    try {
      geo = await geocodeAddress(address);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ id: row.id, address, reason: message });
      console.log(`  ✗ ${label} — geocode error: ${message}`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      continue;
    }

    const refusal = precisionRefusal(geo);
    if (refusal) {
      refusals.push({ id: row.id, address, reason: refusal });
      console.log(`  ⊘ ${label} — REFUSED: ${refusal}`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      continue;
    }

    if (!LIVE) {
      wouldWrite += 1;
      console.log(`  ✓ ${label} → ${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)} (${geo.locationType})`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      continue;
    }

    const { error: updErr } = await sb
      .from('properties')
      .update({ lat: geo.lat, lng: geo.lng })
      .eq('id', row.id);
    if (updErr) {
      failures.push({ id: row.id, address, reason: `update failed: ${updErr.message}` });
      console.log(`  ✗ ${label} — update failed: ${updErr.message}`);
    } else {
      written += 1;
      console.log(`  ✓ ${label} → ${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)} (${geo.locationType})`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n--- summary (${LIVE ? 'LIVE' : 'DRY RUN'}) ---`);
  console.log(`  ${LIVE ? 'written' : 'would write'}: ${LIVE ? written : wouldWrite}`);
  console.log(`  refused on precision: ${refusals.length}`);
  console.log(`  geocode/update errors: ${failures.length}`);
  console.log(`  rows with no address: ${blank.length}`);

  if (refusals.length) {
    console.log('\nREFUSED — these addresses did not resolve to a specific house.');
    console.log('They keep lat/lng NULL. Fix the address and re-run; do NOT relax the gate.');
    for (const r of refusals) console.log(`  ${r.id}  ${r.address}\n      ${r.reason}`);
  }
  if (failures.length) {
    console.log('\nERRORS — retry these on a re-run:');
    for (const f of failures) console.log(`  ${f.id}  ${f.address}\n      ${f.reason}`);
  }
  if (!LIVE) {
    console.log(`\nNothing was written. To apply: BACKFILL_CONSENT=${today} npx tsx scripts/backfill-property-coords.ts --live`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
