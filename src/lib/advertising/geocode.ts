// Reverse geocoding for placement capture: lat/lng -> a human-readable
// suggested address. GRACEFUL: every failure (no key, HTTP error, no result)
// returns null, because the GPS point is the record and the address is a
// convenience for the review screen — a capture must never fail over this.

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      results?: Array<{ formatted_address?: string }>;
    };
    if (data.status !== 'OK') return null;
    const address = data.results?.[0]?.formatted_address;
    return typeof address === 'string' && address.trim() ? address.trim() : null;
  } catch {
    return null;
  }
}
