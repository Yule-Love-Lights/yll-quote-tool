import { getSupabaseClient } from './supabase';
import { LineSegment, MiniLightDetection, WreathDetection, SpritzerDetection } from './photoAnalysis';
import type { Spritzer, Wreath, GarlandItem } from './pricing/pricingEngine';

export type PhotoTag =
  | 'front_install'
  | 'front_takedown'
  | 'side'
  | 'back'
  | 'satellite'
  | 'detail'
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
  miniLightDetections: MiniLightDetection[];
  wreathDetections?: WreathDetection[];
  spritzerDetections?: SpritzerDetection[];
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
  mini_light_detections: MiniLightDetection[];
  wreath_detections: WreathDetection[];
  spritzer_detections: SpritzerDetection[];
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
  const supabase = getSupabaseClient();
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
      mini_light_detections: payload.miniLightDetections,
      wreath_detections: payload.wreathDetections ?? [],
      spritzer_detections: payload.spritzerDetections ?? [],
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
  const supabase = getSupabaseClient();
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
  const supabase = getSupabaseClient();
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
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  // Pull a larger recent pool, rank client-side by style match, then take top N.
  const { data, error } = await supabase
    .from('training_houses')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.max(limit * 5, 10));
  if (error) return [];

  const all = (data ?? []) as StoredTrainingHouse[];
  if (!styleHint) return all.slice(0, limit);

  const hint = styleHint.toLowerCase().trim();
  const scored = all.map(h => {
    const s = (h.house_style ?? '').toLowerCase();
    const exact = s && s === hint;
    const partial = s && (s.includes(hint) || hint.includes(s));
    return { h, score: exact ? 2 : partial ? 1 : 0 };
  });
  scored.sort((a, b) => b.score - a.score); // stable-ish: preserves recency within same score
  return scored.slice(0, limit).map(x => x.h);
}

export async function deleteTrainingHouse(id: string): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  const { error } = await supabase.from('training_houses').delete().eq('id', id);
  if (error) {
    console.error('deleteTrainingHouse error:', error);
    return false;
  }
  return true;
}
