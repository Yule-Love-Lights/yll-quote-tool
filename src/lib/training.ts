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

/**
 * Where a training house came from. Drives few-shot eligibility, not just
 * provenance: 'manual' houses are traced on ground-level photos and are the
 * ONLY ones getTrainingFewShot serves to customer-photo analysis; 'archive'
 * houses (#167) are traced on overhead satellites and are deliberately held
 * out of that pool. Adding a value here is a corpus decision — check
 * getTrainingFewShot before you add one.
 */
export type TrainingHouseSource = 'manual' | 'archive';

export type TrainingHousePayload = {
  /** Defaults to 'manual'. Archive promotions (#167 slice 3) must pass 'archive'. */
  source?: TrainingHouseSource;
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
  aiFailureNotes?: string | null;
  costMaterials?: number | null;
  costLaborHours?: number | null;
  revenue?: number | null;
};

export type StoredTrainingHouse = {
  id: string;
  created_at: string;
  source: TrainingHouseSource;
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

// W5-029: the list card (training/page.tsx) only ever reads this subset —
// keep it column-projected in listTrainingHouses rather than SELECT * so a
// list render doesn't pull every row's full base64 photos + unused detection
// arrays just to build a thumbnail grid.
export type TrainingListItem = Pick<
  StoredTrainingHouse,
  'id' | 'address' | 'year_completed' | 'house_style' | 'santas_footage' | 'gingerbread_footage'
  | 'mini_light_detections' | 'wreaths'
> & {
  thumbnail: TrainingPhoto | null;
  photoCount: number;
};

// W5-028: address/houseStyle/notes/aiFailureNotes are stored uncapped and
// aiFailureNotes is injected raw into a synthetic assistant message the
// analyzer imitates as ground truth. Strip control characters and cap length
// so a huge or control-char-laden write can't poison the corpus text.
const MAX_TEXT_LEN = 2000;
function sanitizeCorpusText(v: string | null | undefined): string | null {
  if (v == null) return null;
  return v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, MAX_TEXT_LEN) || null;
}

export async function saveTrainingHouse(payload: TrainingHousePayload): Promise<{ id: string } | null> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('training_houses')
    .insert({
      // Explicit rather than leaning on the column default: an archive
      // promotion that forgot this would silently default to 'manual' and put
      // an overhead-satellite trace back into ground-photo few-shot — the exact
      // contamination the source column exists to prevent.
      source: payload.source ?? 'manual',
      address: sanitizeCorpusText(payload.address),
      year_completed: payload.yearCompleted ?? null,
      house_style: sanitizeCorpusText(payload.houseStyle),
      notes: sanitizeCorpusText(payload.notes),
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
      scale_anchor: null,
      didnt_install: null,
      ai_failure_notes: sanitizeCorpusText(payload.aiFailureNotes),
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

// Listing view — column-projected to only what the list card renders (W5-029):
// still needs `photos` to derive the thumbnail (Supabase can't slice a jsonb
// array server-side), but skips every other unused big column (lines,
// detections, spritzers/garland, notes, cost/revenue) that select('*') was
// pulling for every row just to build a preview grid.
const LIST_COLUMNS =
  'id, address, year_completed, house_style, photos, santas_footage, gingerbread_footage, mini_light_detections, wreaths';

export async function listTrainingHouses(limit = 100): Promise<TrainingListItem[]> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('training_houses')
    .select(LIST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listTrainingHouses error:', error);
    return [];
  }
  type ListRow = Pick<StoredTrainingHouse, 'id' | 'address' | 'year_completed' | 'house_style' | 'photos' | 'santas_footage' | 'gingerbread_footage' | 'mini_light_detections' | 'wreaths'>;
  return ((data ?? []) as unknown as ListRow[]).map(h => {
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
  // #167 slice 3: ground-photo few-shot ONLY. Archive-sourced houses are traced
  // on an overhead satellite, and analyzePhoto tells the model these exemplars
  // are ground truth whose "precision and coordinate style" it should match —
  // overhead geometry is the wrong thing to imitate on a customer's ground-level
  // front elevation. The ~80 archive properties also all land at once, so an
  // unfiltered recency pool would be mostly archive rows.
  // POSITIVE match (=== 'manual'), never `neq('archive')`: a negative gate
  // silently hands every future source the ground-photo retrieval it was never
  // vetted for (the seam-gate pitfall).
  const { data: candidates, error: poolErr } = await supabase
    .from('training_houses')
    .select('id, house_style, created_at')
    .eq('source', 'manual')
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
