// Google Maps helpers: geocode + fetch Street View and satellite imagery.
// All functions graceful-degrade when GOOGLE_MAPS_API_KEY is missing.

export function isGoogleMapsConfigured(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

function getKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not configured');
  return key;
}

// Default ceiling for an outbound Google call. Google usually answers in well
// under 2s; this just stops a hung connection from stalling a whole request
// (the analyze-address flow chains geocode + street view + satellite, so one
// hang would otherwise freeze the operator's quote build).
const DEFAULT_TIMEOUT_MS = 10_000;

// fetch() with a hard timeout via AbortController. On timeout it throws a clear
// error that does NOT include the URL's query string (which carries the API
// key) — so the key never lands in logs. Exported for testing.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url.split('?')[0]}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type GeocodeResult = {
  lat: number;
  lng: number;
  formattedAddress: string;
  // County (administrative_area_level_2, e.g. "Nassau County") and state
  // (administrative_area_level_1 long name, e.g. "New York"), parsed from the
  // geocode's address components. Additive/optional: existing callers ignore
  // them; the self-serve service-area gate reads them. Either may be undefined
  // when Google omits that component (rare for a resolvable street address).
  county?: string;
  state?: string;
  // Precision signals. When Google can't resolve a street address it silently
  // falls back to a TOWN/ZIP centroid (location_type 'APPROXIMATE',
  // partial_match true, types ['locality','political'], no street_number) —
  // which still carries a valid county. The self-serve estimator must not quote
  // that: it would measure whatever building sits at the centroid and hand the
  // customer a confident price for a house we never located. Additive/optional.
  /** Google's `geometry.location_type`: ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE. */
  locationType?: string;
  /** Google's `partial_match` — true when the result is a fuzzy match for the query. */
  partialMatch?: boolean;
  /** True when the result carries BOTH street_number and route (a real street address, not a centroid). */
  hasStreetAddress?: boolean;
};

// Pull one address component's long_name by its Google `type`. Exported for
// testing the parse without a live geocode call.
export function addressComponent(
  components: Array<{ long_name?: string; types?: string[] }> | undefined,
  type: string,
): string | undefined {
  if (!Array.isArray(components)) return undefined;
  const hit = components.find((c) => Array.isArray(c.types) && c.types.includes(type));
  const name = hit?.long_name?.trim();
  return name || undefined;
}

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const key = getKey();
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.[0]) {
    throw new Error(`Geocode failed: ${data.status ?? 'no results'}`);
  }
  const top = data.results[0];
  return {
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
    formattedAddress: top.formatted_address,
    county: addressComponent(top.address_components, 'administrative_area_level_2'),
    state: addressComponent(top.address_components, 'administrative_area_level_1'),
    locationType: top.geometry?.location_type,
    partialMatch: top.partial_match === true,
    hasStreetAddress:
      addressComponent(top.address_components, 'street_number') != null &&
      addressComponent(top.address_components, 'route') != null,
  };
}

export type FetchedImage = {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
};

// Street View Static API — front elevation of the house.
// Uses lat/lng for precise positioning; the Street View camera will snap to the
// closest available panorama. Heading defaults to auto (aimed at the target
// location); pass an explicit value to rotate the camera when obstacles like
// trees or parked cars block the default angle.
export async function fetchStreetView(
  lat: number,
  lng: number,
  opts?: { size?: string; fov?: number; heading?: number; pitch?: number },
): Promise<FetchedImage> {
  const key = getKey();
  // Landscape 8:5 (#62). Width caps at 640px on the standard tier, so a
  // rectangular front elevation = same width, less height. At fov 80° the
  // shorter canvas just trims sky/ground (vertical fov ≈ 80°·400/640 ≈ 50°),
  // keeping the house width + roofline in frame — vs the old square 640x640.
  const size = opts?.size ?? '640x400';
  const fov = opts?.fov ?? 80;
  const headingParam = opts?.heading != null ? `&heading=${opts.heading}` : '';
  const pitchParam = opts?.pitch != null ? `&pitch=${opts.pitch}` : '';
  const url = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${lat},${lng}&fov=${fov}${headingParam}${pitchParam}&source=outdoor&key=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Street View fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Google returns JPEG for streetview
  return { base64: buf.toString('base64'), mediaType: 'image/jpeg' };
}

// The panorama Google snaps to for a location, from the (free) Street View
// metadata endpoint: its status + the pano's ACTUAL coords/id. Used to step the
// camera along the road and land on real adjacent panoramas (#15).
export type StreetViewPano = { status: string; panoId?: string; lat?: number; lng?: number };

export async function resolveStreetViewPano(lat: number, lng: number): Promise<StreetViewPano> {
  const key = getKey();
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return { status: 'HTTP_ERROR' };
  const data = await res.json();
  return { status: data.status, panoId: data.pano_id, lat: data.location?.lat, lng: data.location?.lng };
}

// Static Maps API — top-down satellite view of the property.
// zoom=20 is tight enough to see individual rooflines on a single-family lot.
export async function fetchSatellite(lat: number, lng: number, opts?: { size?: string; zoom?: number }): Promise<FetchedImage> {
  const key = getKey();
  const size = opts?.size ?? '640x640';
  const zoom = opts?.zoom ?? 20;
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${size}&maptype=satellite&key=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Satellite fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), mediaType: 'image/png' };
}

// #110 W5-013 (cost): analyze-address re-fetches geocode + Street View +
// satellite on EVERY call, even for a repeat of the same address (common
// during staff testing / a retry after an analyzer outage). Cache the full
// imagery bundle by a normalized address key, in-memory, for a short TTL —
// suitable for the single-process Vercel-serverless runtime this project runs
// in (mirrors the rate-limiter's in-memory Map convention), not a strong
// cross-region cache.
export const __ADDRESS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type AddressImagery = {
  geo: GeocodeResult;
  streetView: FetchedImage;
  satellite: FetchedImage;
  satelliteFeetPerPixel: number;
  /**
   * The Street View panorama's ACTUAL camera coords, from the (free) metadata
   * call we already make to probe availability — null when metadata omits
   * them. The camera sits on the road the house is addressed on, so the
   * house→camera bearing is the direction the FRONT of the house faces (S25
   * permanent-analyzer orientation).
   */
  panoLocation: { lat: number; lng: number } | null;
};

type ImageryCacheEntry = { value: AddressImagery; expiresAt: number };
const imageryCache = new Map<string, ImageryCacheEntry>();

function normalizeAddressKey(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Test-only: reset the cache between test cases. Not part of the runtime API. */
export function __clearImageryCache(): void {
  imageryCache.clear();
}

// Thrown by the route as a 404 — kept distinct from a generic fetch failure so
// the caller can map it to the right status code even when served from cache.
export class NoStreetViewError extends Error {}

export async function getCachedAddressImagery(address: string): Promise<AddressImagery> {
  const key = normalizeAddressKey(address);
  const now = Date.now();
  const cached = imageryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const geo = await geocodeAddress(address);

  // Resolve the pano directly (hasStreetView wraps the same metadata call but
  // discards the camera coords we now keep for orientation).
  const pano = await resolveStreetViewPano(geo.lat, geo.lng);
  if (pano.status !== 'OK') {
    throw new NoStreetViewError(`No Street View imagery available at ${geo.formattedAddress}`);
  }
  const panoLocation = pano.lat != null && pano.lng != null ? { lat: pano.lat, lng: pano.lng } : null;

  const [streetView, satellite] = await Promise.all([
    fetchStreetView(geo.lat, geo.lng),
    fetchSatellite(geo.lat, geo.lng),
  ]);

  // Same feet-per-pixel derivation as before: Google Static Maps at zoom=20 —
  // meters_per_pixel = 156543.03392 * cos(lat) / 2^zoom, converted to feet.
  const SAT_ZOOM = 20;
  const metersPerPixel = (156543.03392 * Math.cos((geo.lat * Math.PI) / 180)) / Math.pow(2, SAT_ZOOM);
  const satelliteFeetPerPixel = metersPerPixel * 3.28084;

  const value: AddressImagery = { geo, streetView, satellite, satelliteFeetPerPixel, panoLocation };
  imageryCache.set(key, { value, expiresAt: now + __ADDRESS_CACHE_TTL_MS });
  return value;
}
