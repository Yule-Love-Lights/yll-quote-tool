import { getSupabaseServiceClient } from './supabase';

// #167 slice 3 — the trace queue behind /training/archive.
//
// Slice 2 left every fetched property at status='ready_to_trace'. This module
// turns those rows into the two lists the page works from:
//
//   properties          — houses ready to trace, GROUPED by resolved_address_key
//                         so a house's multiple angles are one card, not nine.
//   needsIdentification — rows with no address at all. They can never be
//                         geocoded, so the imagery worker skips them forever;
//                         a human has to look at the night photo and say which
//                         house it is. Without this lane they sit in 'pending'
//                         permanently (slice-1 audit follow-up #3).
//
// Storage is private, so every image path is signed here rather than handed to
// the client raw.

const BUCKET = 'training-archive';
// Long enough for a tracing sitting without minting effectively-permanent URLs.
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export type ArchiveQueuePhoto = {
  id: string;
  title: string | null;
  /** Signed URL for the archive night photo, or null if it hasn't been copied into the bucket yet. */
  nightPhotoUrl: string | null;
};

export type ArchiveQueueProperty = {
  addressKey: string;
  address: string;
  photoCount: number;
  photos: ArchiveQueuePhoto[];
  satelliteUrl: string | null;
  streetViewUrl: string | null;
  /**
   * Feet per pixel of the stored satellite, with the pixel dimensions it was
   * measured on. The tracer needs all three: its coordinates are normalized to
   * image WIDTH, so the scale it wants is feetPerPixel * satelliteW.
   */
  satelliteFeetPerPixel: number | null;
  satelliteW: number | null;
  satelliteH: number | null;
  /** Set once a trace has been promoted, so the card can show "done" instead of offering the work twice. */
  promotedTrainingHouseId: string | null;
};

export type ArchiveNeedsIdRow = {
  id: string;
  title: string | null;
  nightPhotoUrl: string | null;
  resolvedName: string | null;
  reviewerNotes: string | null;
};

export type ArchiveQueue = {
  properties: ArchiveQueueProperty[];
  needsIdentification: ArchiveNeedsIdRow[];
  /** Properties still to trace (excludes any already promoted). */
  remaining: number;
};

type QueueRow = {
  id: string;
  original_title: string | null;
  resolved_address: string | null;
  resolved_address_key: string | null;
  resolved_name: string | null;
  reviewer_notes: string | null;
  night_photo_ref: string | null;
  satellite_ref: string | null;
  street_view_ref: string | null;
  satellite_feet_per_pixel: number | null;
  satellite_w: number | null;
  satellite_h: number | null;
  promoted_training_house_id: string | null;
  status: string;
};

const QUEUE_COLUMNS =
  'id, original_title, resolved_address, resolved_address_key, resolved_name, reviewer_notes, ' +
  'night_photo_ref, satellite_ref, street_view_ref, satellite_feet_per_pixel, satellite_w, ' +
  'satellite_h, promoted_training_house_id, status';

/**
 * Sign a batch of private storage paths in one call. Returns a path -> URL map;
 * anything that fails to sign is simply absent, so a missing image degrades to
 * "no thumbnail" rather than failing the whole queue load.
 */
async function signPaths(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(paths)];
  if (unique.length === 0) return out;

  const sb = getSupabaseServiceClient();
  if (!sb) return out;

  try {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);
    if (error || !data) return out;
    for (const entry of data) {
      if (entry.path && entry.signedUrl) out.set(entry.path, entry.signedUrl);
    }
  } catch {
    return out;
  }
  return out;
}

export async function getArchiveQueue(): Promise<ArchiveQueue> {
  const empty: ArchiveQueue = { properties: [], needsIdentification: [], remaining: 0 };
  const sb = getSupabaseServiceClient();
  if (!sb) return empty;

  // 'excluded' rows are not installs. Everything else is either queue work or a
  // row waiting on a human to name its house.
  const { data, error } = await sb
    .from('archive_photos')
    .select(QUEUE_COLUMNS)
    .neq('status', 'excluded')
    .order('original_title', { ascending: true });
  if (error || !data) {
    console.error('getArchiveQueue error:', error?.message);
    return empty;
  }

  const rows = data as unknown as QueueRow[];

  // The lane is defined by "no address to geocode", not by status: a row can be
  // addressless and still sit at whatever status the loader left it at.
  const needsIdRows = rows.filter(r => !r.resolved_address);
  const traceRows = rows.filter(r => r.resolved_address && r.resolved_address_key);

  const signed = await signPaths([
    ...rows.map(r => r.night_photo_ref).filter((p): p is string => !!p),
    ...traceRows.map(r => r.satellite_ref).filter((p): p is string => !!p),
    ...traceRows.map(r => r.street_view_ref).filter((p): p is string => !!p),
  ]);

  const byKey = new Map<string, QueueRow[]>();
  for (const row of traceRows) {
    const key = row.resolved_address_key!;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  const properties: ArchiveQueueProperty[] = [];
  for (const [addressKey, group] of byKey) {
    // Imagery is attached per property, but only to the rows the worker
    // claimed — read it from whichever row in the group actually carries it
    // rather than assuming the first one does.
    const withImagery = group.find(r => r.satellite_ref) ?? group[0];
    const promoted = group.find(r => r.promoted_training_house_id)?.promoted_training_house_id ?? null;

    properties.push({
      addressKey,
      address: group.find(r => r.resolved_address)?.resolved_address ?? addressKey,
      photoCount: group.length,
      photos: group.map(r => ({
        id: r.id,
        title: r.original_title,
        nightPhotoUrl: r.night_photo_ref ? signed.get(r.night_photo_ref) ?? null : null,
      })),
      satelliteUrl: withImagery.satellite_ref ? signed.get(withImagery.satellite_ref) ?? null : null,
      streetViewUrl: withImagery.street_view_ref ? signed.get(withImagery.street_view_ref) ?? null : null,
      satelliteFeetPerPixel: withImagery.satellite_feet_per_pixel,
      satelliteW: withImagery.satellite_w,
      satelliteH: withImagery.satellite_h,
      promotedTrainingHouseId: promoted,
    });
  }

  // Untraced first — the queue is a grind-down list, so finished houses sink.
  properties.sort((a, b) => {
    if (!!a.promotedTrainingHouseId !== !!b.promotedTrainingHouseId) {
      return a.promotedTrainingHouseId ? 1 : -1;
    }
    return a.address.localeCompare(b.address);
  });

  return {
    properties,
    needsIdentification: needsIdRows.map(r => ({
      id: r.id,
      title: r.original_title,
      nightPhotoUrl: r.night_photo_ref ? signed.get(r.night_photo_ref) ?? null : null,
      resolvedName: r.resolved_name,
      reviewerNotes: r.reviewer_notes,
    })),
    remaining: properties.filter(p => !p.promotedTrainingHouseId).length,
  };
}

/**
 * Give an addressless row the address a human read off its night photo. The row
 * goes back to 'pending' so slice 2's imagery worker claims it on the next run —
 * this does NOT fetch imagery itself, it just makes the row claimable.
 */
export async function identifyArchivePhoto(id: string, address: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = address.trim();
  if (!trimmed) return { ok: false, error: 'An address is required' };

  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase is not configured' };

  // Only ever fills a BLANK address. Re-pointing a row that already has one is a
  // different, riskier operation (its imagery and any promoted trace were
  // derived from the old address) and is deliberately not offered here.
  const { data, error } = await sb
    .from('archive_photos')
    .update({ resolved_address: trimmed, status: 'pending', updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('resolved_address', null)
    .select('id');
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: 'That photo already has an address' };
  return { ok: true };
}

/** Mark a row as not an install, so it leaves the queue permanently. */
export async function excludeArchivePhoto(id: string, note?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase is not configured' };

  const patch: Record<string, unknown> = { status: 'excluded', updated_at: new Date().toISOString() };
  if (note?.trim()) patch.reviewer_notes = note.trim();

  const { error } = await sb.from('archive_photos').update(patch).eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
