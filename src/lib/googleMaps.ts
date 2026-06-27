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
};

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

// Check whether Street View imagery exists at the given location before
// consuming a billable tile request. Returns true when a panorama is available.
export async function hasStreetView(lat: number, lng: number): Promise<boolean> {
  const key = getKey();
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${key}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return false;
  const data = await res.json();
  return data.status === 'OK';
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
