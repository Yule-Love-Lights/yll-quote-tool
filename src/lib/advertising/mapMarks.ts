import { getSupabaseServiceClient } from '@/lib/supabase';
import { logAdvertisingActivity } from '@/lib/advertising/activity';

// Places the owner marks on the map: WHERE TO GO (hot spots) and WHERE NOT
// TO (avoid). Both are his knowledge rather than anything the data derives.
// There is no results data to rank spots by yet, and a no-go is usually a
// phone call nobody logged.
//
// A mark is a point with an OPTIONAL radius: one corner is a point, "the
// whole village" is a point with a few hundred metres on it. Radius beats a
// traced polygon for something placed from a phone.
//
// These sit alongside the residential rule, not instead of it. The tool
// refuses a yard sign on residential land from OpenStreetMap's own
// classification; these marks are the human layer, and an avoid mark can
// sit on a road the classifier thinks is fine.

export type MapMarkKind = 'hotspot' | 'avoid';
export const MAP_MARK_KINDS = ['hotspot', 'avoid'] as const;

export function isMapMarkKind(value: unknown): value is MapMarkKind {
  return value === 'hotspot' || value === 'avoid';
}

export type AdvertisingMapMark = {
  id: string;
  kind: MapMarkKind;
  label: string;
  note: string | null;
  lat: number;
  lng: number;
  /** Null means a single point; a number draws a circle of that many metres. */
  radiusM: number | null;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  kind: string;
  label: string;
  note: string | null;
  lat: number;
  lng: number;
  radius_m: number | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
};

const SELECT = 'id, kind, label, note, lat, lng, radius_m, active, created_by, created_at';
const PAGE = 1000;
/** Wider than a circle a person would ever mean to drop from a phone. */
const MAX_RADIUS_M = 20000;

function toMark(row: Row): AdvertisingMapMark {
  return {
    id: row.id,
    kind: isMapMarkKind(row.kind) ? row.kind : 'hotspot',
    label: row.label,
    note: row.note,
    lat: row.lat,
    lng: row.lng,
    radiusM: row.radius_m,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Every mark, newest first. Paged to completeness: this is what the crew is
 * shown, so a silently truncated read would hide a no-go area, which is the
 * one thing on this screen that exists to keep them out of trouble.
 */
export async function listMapMarks(opts?: { activeOnly?: boolean }): Promise<AdvertisingMapMark[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const marks: AdvertisingMapMark[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = db.from('advertising_map_marks').select(SELECT);
    if (opts?.activeOnly) query = query.eq('active', true);
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('listMapMarks error:', error);
      return [];
    }
    const rows = (data ?? []) as Row[];
    marks.push(...rows.map(toMark));
    if (rows.length < PAGE) break;
  }
  return marks;
}

/** Drop a mark on the map. */
export async function createMapMark(input: {
  kind: MapMarkKind;
  label: string;
  lat: number;
  lng: number;
  note?: string | null;
  radiusM?: number | null;
  createdBy: string;
}): Promise<AdvertisingMapMark> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  if (!isMapMarkKind(input.kind)) {
    throw new Error(`createMapMark: unknown kind ${String(input.kind)}`);
  }
  const label = input.label.trim();
  if (!label) throw new Error('createMapMark: a name is required');
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
    throw new Error('createMapMark: a position is required');
  }
  if (input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) {
    throw new Error('createMapMark: that position is off the map');
  }
  const radiusM = input.radiusM ?? null;
  if (radiusM !== null && (!Number.isInteger(radiusM) || radiusM <= 0 || radiusM > MAX_RADIUS_M)) {
    throw new Error(`createMapMark: a radius must be a whole number of metres, 1 to ${MAX_RADIUS_M}`);
  }

  const { data, error } = await db
    .from('advertising_map_marks')
    .insert({
      kind: input.kind,
      label,
      note: input.note?.trim() || null,
      lat: input.lat,
      lng: input.lng,
      radius_m: radiusM,
      created_by: input.createdBy,
    })
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`createMapMark: ${error.message}`);
  if (!data) throw new Error('createMapMark: no row returned');
  const mark = toMark(data as Row);

  await logAdvertisingActivity({
    actor: input.createdBy,
    action: 'map_mark_added',
    detail: { markId: mark.id, kind: mark.kind, label: mark.label, radiusM: mark.radiusM },
  });
  return mark;
}

/**
 * Retire a mark: it stops being shown to the crew, and the record that it
 * was once tried survives. There is no hard delete, because "we stopped
 * sending people here" is worth keeping.
 */
export async function retireMapMark(id: string, retiredBy: string): Promise<AdvertisingMapMark> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('advertising_map_marks')
    .update({ active: false })
    .eq('id', id.trim())
    .eq('active', true)
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`retireMapMark: ${error.message}`);

  if (!data) {
    // Either it never existed or it is already retired. Read it back so a
    // repeated tap is idempotent rather than an error on a done thing.
    const { data: current } = await db
      .from('advertising_map_marks')
      .select(SELECT)
      .eq('id', id.trim())
      .limit(1);
    const row = ((current ?? []) as Row[])[0];
    if (!row) throw new Error(`retireMapMark: no mark found for id ${id.trim()}`);
    return toMark(row);
  }

  const mark = toMark(data as Row);
  await logAdvertisingActivity({
    actor: retiredBy,
    action: 'map_mark_retired',
    detail: { markId: mark.id, kind: mark.kind, label: mark.label },
  });
  return mark;
}
