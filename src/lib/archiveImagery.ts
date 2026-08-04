// #167 P1 slice 2 — fetch the daytime Google imagery for each archived
// property, so slice 3's review queue can hand a human a satellite image with a
// known scale to trace on.
//
// Slice 1 loaded 211 archive photos across 77 distinct properties. Every photo
// is a NIGHT shot of a finished install — useful as "what we actually built"
// reference, useless as something to trace geometry on. The tracer works on the
// daytime satellite, exactly like /training/new and the quote builder do.
//
// SHAPE: work is claimed and committed per PROPERTY (grouped by
// resolved_address_key), never per photo — a house with 9 archive photos gets
// ONE geocode, ONE satellite, ONE Street View, and all 9 rows point at them.
// The run is resumable: it stops on a wall-clock deadline well inside the
// route's maxDuration, and a failed property records why in imagery_error
// instead of being silently retried forever.
//
// WHY THIS ISN'T getCachedAddressImagery(): that helper throws
// NoStreetViewError BEFORE it fetches the satellite when a location has no
// panorama. For the estimator that's correct (it needs the front elevation).
// Here it is exactly backwards — the satellite is the thing being traced and
// Street View is a nice-to-have reference, so a house on a private lane with no
// pano must still get its satellite. This module calls the primitives directly.

import { createHash } from 'crypto';
import { getSupabaseServiceClient } from './supabase';
import {
  geocodeAddress,
  fetchSatellite,
  fetchStreetView,
  resolveStreetViewPano,
  isGoogleMapsConfigured,
} from './googleMaps';
import { isPreciseAddress } from './selfServe/serviceArea';

const BUCKET = 'training-archive';

// Pinned EXPLICITLY rather than relying on fetchSatellite's defaults. The
// feet-per-pixel we store is derived from this zoom, and satellite_w/_h from
// this size — if the shared helper's defaults ever move, silently inheriting
// them would leave every already-stored scale wrong with nothing to notice it.
const SAT_ZOOM = 20;
const SAT_SIZE = '640x640';

// Street View reference shot. Same landscape framing /api/analyze-address uses
// so an archive property's reference looks like every other one in the app.
const SV_SIZE = '640x400';

// Stop claiming new properties once the run has been going this long. The route
// declares maxDuration = 60; a property costs ~2s (geocode + pano + 2 image
// fetches + 2 uploads + 1 update), but a slow leg can cost up to the shared
// 10s-per-call timeout four times over. Stopping at 45s means the run always
// returns its partial results instead of being killed mid-property, and the
// operator just clicks again.
const DEADLINE_MS = 45_000;

const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export type ArchivePropertyResult = {
  addressKey: string;
  /** The raw address as the naming pass typed it — what actually got geocoded. */
  address: string;
  /** How many archive_photos rows this property covers. */
  photos: number;
  ok: boolean;
  satelliteRef?: string;
  /** null when the property has no Street View panorama (not an error). */
  streetViewRef?: string | null;
  error?: string;
};

export type ArchiveImageryRun = {
  /** Properties this run actually worked (ok + failed). */
  attempted: number;
  fetched: number;
  failed: number;
  /**
   * Distinct properties still claimable on a NEXT run with the same options.
   * Failed properties are excluded (they now carry imagery_error, so the
   * default claim skips them) — re-run with retryFailed to pick them back up.
   */
  remaining: number;
  stoppedOnDeadline: boolean;
  results: ArchivePropertyResult[];
};

type ClaimRow = {
  id: string;
  resolved_address: string;
  resolved_address_key: string;
};

/**
 * Storage prefix for a property's imagery. resolved_address_key is free-form
 * text ("18 daisy court farmingdale new york 11735") and must never be used as
 * a storage key directly, so it is slugged for a human browsing the bucket and
 * suffixed with a hash of the FULL key so two long addresses that slug to the
 * same 60 characters can't collide onto one another's images.
 */
export function archiveStoragePrefix(addressKey: string): string {
  const slug = addressKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  const hash = createHash('sha256').update(addressKey).digest('hex').slice(0, 8);
  return `${slug || 'address'}-${hash}`;
}

/**
 * Google Static Maps ground resolution at a given latitude and zoom, in FEET
 * per image pixel. Same derivation getCachedAddressImagery uses; duplicated
 * here (rather than imported) because that function computes it as a private
 * step of a bundle this module deliberately does not call.
 */
export function satelliteFeetPerPixel(lat: number, zoom: number = SAT_ZOOM): number {
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  return metersPerPixel * 3.28084;
}

/**
 * Width/height straight out of a PNG's IHDR chunk.
 *
 * The tracer needs the pixel canvas its lines were drawn on, and the honest
 * source of that is the bytes we actually stored — NOT the size we asked
 * Google for. Reading the header (rather than trusting SAT_SIZE, or pulling
 * sharp in) keeps this module free of any image-processing import, which
 * matters because slice 3's queue page will want its types.
 *
 * Returns null when the buffer is not a PNG — treated as a fetch failure, not
 * silently defaulted, since a non-PNG body means Google handed back something
 * other than the map we asked for.
 */
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  // 8-byte signature, then a 4-byte length + 'IHDR' type, then width/height.
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Error text safe to persist into a column an operator reads. Strips any
 * `key=...` that a lower-level fetch error might have carried through (the
 * Google URLs this module builds all embed the API key) and bounds the length.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/key=[^&\s]+/gi, 'key=***').slice(0, 300);
}

function groupByProperty(rows: ClaimRow[]): Map<string, ClaimRow[]> {
  const groups = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    const key = row.resolved_address_key;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  // Deterministic order within a property so the address we geocode is the same
  // one on every run (the rows in a group share a normalized key but their raw
  // text can still differ in case/punctuation).
  for (const bucket of groups.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  return groups;
}

/**
 * Fetch and attach imagery for up to `limit` un-imaged properties.
 *
 * Claims rows that are still 'pending' with no satellite_ref and a non-null
 * resolved_address. Rows whose address is null (a customer-linked photo whose
 * address was never typed, or a not-in-CRM photo) are deliberately NOT claimed:
 * there is nothing to geocode, and they belong in slice 3's needs-identification
 * lane where a human supplies the address.
 */
export async function fetchArchiveImageryBatch(opts?: {
  limit?: number;
  /** Also pick up properties that recorded an imagery_error on a previous run. */
  retryFailed?: boolean;
  deadlineMs?: number;
}): Promise<ArchiveImageryRun> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  if (!isGoogleMapsConfigured()) throw new Error('GOOGLE_MAPS_API_KEY not configured');

  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(opts?.limit ?? DEFAULT_LIMIT)));
  const deadline = Date.now() + (opts?.deadlineMs ?? DEADLINE_MS);

  let query = sb
    .from('archive_photos')
    .select('id, resolved_address, resolved_address_key')
    .eq('status', 'pending')
    .is('satellite_ref', null)
    .not('resolved_address', 'is', null);
  if (!opts?.retryFailed) query = query.is('imagery_error', null);

  // Unbounded on purpose: the whole claimable set is 159 rows today and the
  // grouping has to see every photo of a property to stamp them all together.
  // PostgREST caps a response at 1000 rows, so a much later manifest drop would
  // silently truncate this — the batch would still be correct (it just works a
  // subset), but `remaining` would understate. Revisit if the table passes ~1000
  // unfetched rows.
  const { data, error } = await query;
  if (error) throw new Error(`archive imagery claim failed: ${error.message}`);

  const groups = groupByProperty((data ?? []) as ClaimRow[]);
  const keys = [...groups.keys()].sort();

  const results: ArchivePropertyResult[] = [];
  let stoppedOnDeadline = false;

  for (const key of keys) {
    if (results.length >= limit) break;
    if (Date.now() >= deadline) {
      stoppedOnDeadline = true;
      break;
    }
    const rows = groups.get(key)!;
    results.push(await fetchOneProperty(sb, key, rows));
  }

  const fetched = results.filter((r) => r.ok).length;
  return {
    attempted: results.length,
    fetched,
    failed: results.length - fetched,
    remaining: keys.length - results.length,
    stoppedOnDeadline,
    results,
  };
}

type ServiceClient = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

async function fetchOneProperty(
  sb: ServiceClient,
  addressKey: string,
  rows: ClaimRow[],
): Promise<ArchivePropertyResult> {
  const address = rows[0].resolved_address;
  const ids = rows.map((r) => r.id);
  const base: Omit<ArchivePropertyResult, 'ok'> = { addressKey, address, photos: rows.length };

  try {
    const geo = await geocodeAddress(address);

    // THE POISONED-CORPUS GUARD. An address typed by hand into the naming pass
    // is not guaranteed to resolve. When Google can't place a street address it
    // does NOT error — it silently returns the town/ZIP centroid (S-era
    // discovery, see isPreciseAddress). Storing that satellite would hand the
    // tracer a picture of a stranger's house and file the resulting geometry as
    // ground truth for THIS address, permanently, in the corpus few-shot
    // retrieval reads from. Bad training data is worse than missing training
    // data, so an imprecise hit is recorded for a human instead of imaged.
    if (!isPreciseAddress(geo)) {
      const detail = `location_type=${geo.locationType ?? 'none'} partial_match=${geo.partialMatch === true} street_address=${geo.hasStreetAddress === true}`;
      throw new Error(
        `Imprecise geocode (${detail}) — Google resolved this to "${geo.formattedAddress}". Needs a human to correct the address.`,
      );
    }

    const satellite = await fetchSatellite(geo.lat, geo.lng, { size: SAT_SIZE, zoom: SAT_ZOOM });
    const satBuf = Buffer.from(satellite.base64, 'base64');
    const dims = pngDimensions(satBuf);
    if (!dims) throw new Error('Satellite response was not a PNG — cannot record the traced canvas size');

    // Street View is BEST EFFORT: a missing panorama (private road, new
    // construction, a rural lot) must not cost the property its satellite.
    let streetViewRef: string | null = null;
    let svBuf: Buffer | null = null;
    const pano = await resolveStreetViewPano(geo.lat, geo.lng);
    if (pano.status === 'OK') {
      const sv = await fetchStreetView(geo.lat, geo.lng, { size: SV_SIZE });
      svBuf = Buffer.from(sv.base64, 'base64');
    }

    const prefix = archiveStoragePrefix(addressKey);
    const satPath = `${prefix}/satellite.png`;
    const { error: satErr } = await sb.storage
      .from(BUCKET)
      .upload(satPath, satBuf, { contentType: 'image/png', upsert: true });
    if (satErr) throw new Error(`satellite upload: ${satErr.message}`);

    if (svBuf) {
      const svPath = `${prefix}/street-view.jpg`;
      const { error: svErr } = await sb.storage
        .from(BUCKET)
        .upload(svPath, svBuf, { contentType: 'image/jpeg', upsert: true });
      // Non-fatal, same reasoning as a missing pano: the satellite is the
      // tracer's input and it is already stored.
      if (svErr) console.error('archive imagery (street view upload):', svErr);
      else streetViewRef = svPath;
    }

    const { error: rowErr } = await sb
      .from('archive_photos')
      .update({
        satellite_ref: satPath,
        street_view_ref: streetViewRef,
        satellite_feet_per_pixel: satelliteFeetPerPixel(geo.lat),
        satellite_w: dims.width,
        satellite_h: dims.height,
        imagery_error: null,
        imagery_fetched_at: new Date().toISOString(),
        status: 'ready_to_trace',
      })
      .in('id', ids)
      // Re-checked at write time: a concurrent run (or a human excluding a
      // photo mid-batch) must not have its status stomped back to the queue.
      .eq('status', 'pending');
    if (rowErr) throw new Error(`row update: ${rowErr.message}`);

    return { ...base, ok: true, satelliteRef: satPath, streetViewRef };
  } catch (err) {
    const message = safeErrorMessage(err);
    // Record WHY on the property's rows. Without this a failed property is
    // indistinguishable from an unfetched one: it would be re-claimed on every
    // run forever and no operator could see which addresses need a human.
    const { error: markErr } = await sb
      .from('archive_photos')
      .update({ imagery_error: message })
      .in('id', ids)
      .eq('status', 'pending');
    if (markErr) console.error('archive imagery (error mark):', markErr);
    return { ...base, ok: false, error: message };
  }
}

export type ArchiveImageryStatus = {
  /** Distinct properties with a usable address, by imagery state. */
  properties: { total: number; withImagery: number; failed: number; pending: number };
  /** Photo rows, by where they sit in the queue. */
  photos: { total: number; pending: number; readyToTrace: number; excluded: number; other: number };
  /**
   * Rows still 'pending' with NO address to geocode — a customer-linked photo
   * whose address was never typed, or a not-in-CRM photo. The imagery worker
   * cannot claim these; slice 3 gives them a needs-identification lane.
   */
  needsAddress: number;
};

/** Queue counters for the operator surface (and for verifying a run landed). */
export async function getArchiveImageryStatus(): Promise<ArchiveImageryStatus> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');

  const { data, error } = await sb
    .from('archive_photos')
    .select('resolved_address_key, status, satellite_ref, imagery_error');
  if (error) throw new Error(`archive imagery status failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    resolved_address_key: string | null;
    status: string;
    satellite_ref: string | null;
    imagery_error: string | null;
  }>;

  const withImagery = new Set<string>();
  const failed = new Set<string>();
  const pendingKeys = new Set<string>();
  const photos = { total: rows.length, pending: 0, readyToTrace: 0, excluded: 0, other: 0 };
  let needsAddress = 0;

  for (const r of rows) {
    if (r.status === 'pending') photos.pending += 1;
    else if (r.status === 'ready_to_trace') photos.readyToTrace += 1;
    else if (r.status === 'excluded') photos.excluded += 1;
    else photos.other += 1;

    if (!r.resolved_address_key) {
      if (r.status === 'pending') needsAddress += 1;
      continue;
    }
    if (r.satellite_ref) withImagery.add(r.resolved_address_key);
    else if (r.status === 'pending' && r.imagery_error) failed.add(r.resolved_address_key);
    else if (r.status === 'pending') pendingKeys.add(r.resolved_address_key);
  }

  // A property that landed imagery is no longer failed or pending, whatever a
  // sibling row says — imagery is attached per property, so one imaged row
  // settles the whole group.
  for (const k of withImagery) {
    failed.delete(k);
    pendingKeys.delete(k);
  }
  for (const k of failed) pendingKeys.delete(k);

  return {
    properties: {
      total: withImagery.size + failed.size + pendingKeys.size,
      withImagery: withImagery.size,
      failed: failed.size,
      pending: pendingKeys.size,
    },
    photos,
    needsAddress,
  };
}
