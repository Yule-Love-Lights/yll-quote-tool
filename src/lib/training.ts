import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { GarlandDetection, LineSegment, MiniLightDetection, WreathDetection, SpritzerDetection } from './photoAnalysis';
import type { Spritzer, Wreath, GarlandItem } from './pricing/pricingEngine';

export type PhotoTag =
  | 'front_install'
  | 'tree_bush'
  | 'other';

export type TrainingPhoto = {
  tag: PhotoTag;
  base64: string;
  mediaType: string;
  caption?: string;
};

export type TrainingHousePayload = {
  address?: string;
  yearCompleted?: number;
  houseStyle?: string;
  notes?: string;
  photos: TrainingPhoto[];
  santasFootage?: number;
  santasDifficulty?: 'easy' | 'medium' | 'hard';
  santasLines: LineSegment[];
  gingerbreadFootage?: number;
  gingerbreadDifficulty?: 'easy' | 'medium' | 'hard';
  gingerbreadLines: LineSegment[];
  winterWonderlandFootage?: number;
  winterWonderlandDifficulty?: 'easy' | 'medium' | 'hard';
  stakeLightingFootage?: number;
  stakeLightingDifficulty?: 'easy' | 'medium' | 'hard';
  stakeLines?: LineSegment[];
  miniLightDetections: MiniLightDetection[];
  wreathDetections?: WreathDetection[];
  spritzerDetections?: SpritzerDetection[];
  garlandDetections?: GarlandDetection[];
  c9Lines?: LineSegment[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];
  scaleAnchor?: string | null;
  didntInstall?: string | null;
  aiFailureNotes?: string | null;
  costMaterials?: number | null;
  costLaborHours?: number | null;
  revenue?: number | null;
};

export type StoredTrainingHouse = {
  id: string;
  created_at: string;
  address: string | null;
  year_completed: number | null;
  house_style: string | null;
  notes: string | null;
  photos: TrainingPhoto[];
  santas_footage: number | null;
  santas_difficulty: 'easy' | 'medium' | 'hard' | null;
  santas_lines: LineSegment[];
  gingerbread_footage: number | null;
  gingerbread_difficulty: 'easy' | 'medium' | 'hard' | null;
  gingerbread_lines: LineSegment[];
  winter_wonderland_footage: number | null;
  winter_wonderland_difficulty: 'easy' | 'medium' | 'hard' | null;
  stake_lighting_footage: number | null;
  stake_lighting_difficulty: 'easy' | 'medium' | 'hard' | null;
  stake_lines: LineSegment[] | null;
  mini_light_detections: MiniLightDetection[];
  wreath_detections: WreathDetection[];
  spritzer_detections: SpritzerDetection[];
  garland_detections: GarlandDetection[] | null;
  c9_lines: LineSegment[] | null;
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];
  scale_anchor: string | null;
  didnt_install: string | null;
  ai_failure_notes: string | null;
  cost_materials: number | null;
  cost_labor_hours: number | null;
  revenue: number | null;
};

export type TrainingListItem = Omit<StoredTrainingHouse, 'photos'> & {
  thumbnail: TrainingPhoto | null;
  photoCount: number;
};

export async function saveTrainingHouse(payload: TrainingHousePayload): Promise<{ id: string } | null> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('training_houses')
    .insert({
      address: payload.address ?? null,
      year_completed: payload.yearCompleted ?? null,
      house_style: payload.houseStyle ?? null,
      notes: payload.notes ?? null,
      photos: payload.photos,
      santas_footage: payload.santasFootage ?? null,
      santas_difficulty: payload.santasDifficulty ?? null,
      santas_lines: payload.santasLines,
      gingerbread_footage: payload.gingerbreadFootage ?? null,
      gingerbread_difficulty: payload.gingerbreadDifficulty ?? null,
      gingerbread_lines: payload.gingerbreadLines,
      winter_wonderland_footage: payload.winterWonderlandFootage ?? null,
      winter_wonderland_difficulty: payload.winterWonderlandDifficulty ?? null,
      stake_lighting_footage: payload.stakeLightingFootage ?? null,
      stake_lighting_difficulty: payload.stakeLightingDifficulty ?? null,
      stake_lines: payload.stakeLines ?? [],
      mini_light_detections: payload.miniLightDetections,
      wreath_detections: payload.wreathDetections ?? [],
      spritzer_detections: payload.spritzerDetections ?? [],
      garland_detections: payload.garlandDetections ?? [],
      c9_lines: payload.c9Lines ?? [],
      spritzers: payload.spritzers,
      wreaths: payload.wreaths,
      garland: payload.garland,
      scale_anchor: payload.scaleAnchor ?? null,
      didnt_install: payload.didntInstall ?? null,
      ai_failure_notes: payload.aiFailureNotes ?? null,
      cost_materials: payload.costMaterials ?? null,
      cost_labor_hours: payload.costLaborHours ?? null,
      revenue: payload.revenue ?? null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('saveTrainingHouse error:', JSON.stringify(error), error?.message);
    return null;
  }
  return { id: data.id };
}

// Listing view — excludes full-size photos from payload (only first one as thumbnail).
// Prevents transferring MB of base64 when the page just needs a preview grid.
export async function listTrainingHouses(limit = 100): Promise<TrainingListItem[]> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('training_houses')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listTrainingHouses error:', error);
    return [];
  }
  return ((data ?? []) as StoredTrainingHouse[]).map(h => {
    const photos = h.photos ?? [];
    const front = photos.find(p => p.tag === 'front_install') ?? photos[0] ?? null;
    const { photos: _photos, ...rest } = h;
    void _photos;
    return { ...rest, thumbnail: front, photoCount: photos.length };
  });
}

export async function getTrainingHouse(id: string): Promise<StoredTrainingHouse | null> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('training_houses')
    .select('*')
    .eq('id', id)
    .single();
  if (error) {
    console.error('getTrainingHouse error:', error);
    return null;
  }
  return data as StoredTrainingHouse;
}

// Pull training houses for few-shot. If styleHint is provided, prefer houses
// matching that style first, then fall back to recency. Returns multi-photo
// houses so the analyzer can see takedown + side + detail shots too.
export async function getTrainingFewShot(
  limit = 2,
  styleHint?: string,
): Promise<StoredTrainingHouse[]> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return [];

  // Two-step fetch: first pull a lightweight pool (id + house_style) so we
  // can rank by style match without downloading full photo base64 for every
  // candidate. Then SELECT * only for the top-N winners.
  const poolSize = Math.max(limit * 5, 10);
  const { data: candidates, error: poolErr } = await supabase
    .from('training_houses')
    .select('id, house_style, created_at')
    .order('created_at', { ascending: false })
    .limit(poolSize);
  if (poolErr || !candidates) return [];

  let winnerIds: string[];
  if (!styleHint) {
    winnerIds = candidates.slice(0, limit).map(c => c.id as string);
  } else {
    const hint = styleHint.toLowerCase().trim();
    const scored = candidates.map(c => {
      const s = (c.house_style ?? '').toLowerCase();
      const exact = s && s === hint;
      const partial = s && (s.includes(hint) || hint.includes(s));
      return { id: c.id as string, score: exact ? 2 : partial ? 1 : 0 };
    });
    scored.sort((a, b) => b.score - a.score); // stable-ish: preserves recency within score
    winnerIds = scored.slice(0, limit).map(x => x.id);
  }

  if (winnerIds.length === 0) return [];

  const { data: full, error: fullErr } = await supabase
    .from('training_houses')
    .select('*')
    .in('id', winnerIds);
  if (fullErr || !full) return [];

  // Preserve the ranked order — .in() returns rows in arbitrary order.
  const byId = new Map(full.map(h => [h.id as string, h as StoredTrainingHouse]));
  return winnerIds.map(id => byId.get(id)).filter((h): h is StoredTrainingHouse => !!h);
}

export async function deleteTrainingHouse(id: string): Promise<boolean> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return false;
  const { error } = await supabase.from('training_houses').delete().eq('id', id);
  if (error) {
    console.error('deleteTrainingHouse error:', error);
    return false;
  }
  return true;
}
