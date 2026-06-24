// Live Google reviews for the customer portal (#22). Replaces the hardcoded
// mock rating/testimonials with the real Google Business Profile aggregate +
// featured 5-star reviews, pulled from the Places API (Place Details).
//
// Graceful-degrades like every other integration here: when GOOGLE_PLACE_ID
// (or the Maps key) is missing, the network call fails, or Google returns no
// usable reviews, fetchGoogleReviews() returns null and the portal keeps its
// existing mock block. Reuses the GOOGLE_MAPS_API_KEY already used for
// Street View / satellite (see googleMaps.ts) — the Places API just has to be
// enabled on that same key in Google Cloud.

// The portal's GoogleReviews component is structurally `{ id, name,
// neighborhood, body }[]` — we produce that shape without importing the
// component (keeps this server-only lib free of the 'use client' module).
export type GoogleReviewItem = {
  id: string;
  name: string;
  // Google reviews have no neighborhood. The card renders "— {name},
  // {neighborhood}", so we reuse this slot for the review's relative time
  // ("a month ago") — real per-review metadata that reads well in the caption.
  neighborhood: string;
  body: string;
};

export type GoogleReviewsData = {
  rating: number; // Google's aggregate (e.g. 4.9) across ALL reviews
  totalReviews: number; // user_ratings_total (e.g. 187)
  reviews: GoogleReviewItem[]; // featured 5-star reviews for the carousel
  reviewsUrl?: string; // Google Maps place URL ("Read all reviews →")
};

// Configured only when BOTH the shared Maps key and a Place ID are present.
export function isGoogleReviewsConfigured(): boolean {
  return !!(process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_PLACE_ID);
}

// The slice of the Places "Place Details" response we read. Everything is
// optional — Google omits fields, and we defend against partial payloads.
type RawPlaceReview = {
  author_name?: string;
  rating?: number;
  text?: string;
  relative_time_description?: string;
  time?: number; // unix seconds — stable per-review id
};

type RawPlaceResult = {
  rating?: number;
  user_ratings_total?: number;
  url?: string;
  reviews?: RawPlaceReview[];
};

// Pure mapper (the testable core): Places `result` → the portal's reviews
// block, or null when there's nothing trustworthy to show.
//
// The carousel card hardcodes a 5-gold-star display, so we only FEATURE
// 5-star reviews with non-empty text — a 4-star review rendered under 5 stars
// would misrepresent it. The headline `rating`/`totalReviews` still reflect
// Google's TRUE aggregate across every review, so nothing is overstated.
export function mapPlaceDetailsToReviews(
  result: RawPlaceResult | null | undefined,
): GoogleReviewsData | null {
  if (!result) return null;

  const rating = typeof result.rating === 'number' ? result.rating : null;
  const totalReviews =
    typeof result.user_ratings_total === 'number' ? result.user_ratings_total : null;
  if (rating == null || totalReviews == null) return null;

  const reviews: GoogleReviewItem[] = (result.reviews ?? [])
    .filter((r) => r.rating === 5 && typeof r.text === 'string' && r.text.trim().length > 0)
    .map((r, i) => ({
      id: r.time != null ? `g${r.time}` : `g-${i}`,
      name: r.author_name?.trim() || 'Google reviewer',
      neighborhood: r.relative_time_description?.trim() || 'Google review',
      body: (r.text as string).trim(),
    }));

  // No usable testimonials → let the portal fall back to its mock block rather
  // than render an empty carousel.
  if (reviews.length === 0) return null;

  return {
    rating,
    totalReviews,
    reviews,
    ...(result.url ? { reviewsUrl: result.url } : {}),
  };
}

// Fetch live reviews for the configured Place. Server-only (uses the secret
// Maps key); never throws into the render — returns null on any failure so the
// portal degrades to its mock block. Cached for 6h (ISR) so a busy portal
// doesn't bill a Places request per visit; reviews change slowly.
export async function fetchGoogleReviews(): Promise<GoogleReviewsData | null> {
  if (!isGoogleReviewsConfigured()) return null;
  const key = process.env.GOOGLE_MAPS_API_KEY as string;
  const placeId = process.env.GOOGLE_PLACE_ID as string;
  const fields = 'rating,user_ratings_total,reviews,url';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
    placeId,
  )}&fields=${fields}&key=${key}`;
  try {
    const res = await fetch(url, { next: { revalidate: 60 * 60 * 6 } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK') return null;
    return mapPlaceDetailsToReviews(data.result);
  } catch {
    return null;
  }
}
