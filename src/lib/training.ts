import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { GarlandDetection, LineSegment, MiniLightDetection, WreathDetection, SpritzerDetection } from './photoAnalysis';
import type { Spritzer, Wreath, GarlandItem } from './pricing/pricingEngine';
import { compareKnownVsAi, type KnownNumbers, type AiSnapshot, type KnownVsAiMiss, type OperatorKnownNumbers } from './training/knownVsAi';
import { invalidateBiasNoteCache } from './biasNoteCache';

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
  aiFailureNotes?: string | null;
  costMaterials?: number | null;
  costLaborHours?: number | null;
  revenue?: number | null;
  // #109 Phase 2 — operator ground truth (what they actually installed) +
  // the AI's own snapshot at Auto-Analyze time. Omitted entirely on a legacy
  // save that never touches this feature — see saveTrainingHouse's fail-open
  // handling for why that matters (the column may not be migrated yet).
  operatorKnownNumbers?: { known?: KnownNumbers; aiSnapshot?: AiSnapshot };
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
  // #109 Phase 2 — nullable; absent on any row saved before this shipped, and
  // (until the migration is applied) absent from the SELECT result entirely
  // when the column doesn't exist yet — callers must not assume it's present.
  operator_known_numbers: OperatorKnownNumbers | null;
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

// #109 Phase 2: Postgrest's "this column doesn't exist" errors — 42703 is
// Postgres' own undefined_column code, PGRST204 is PostgREST's "column not
// found in schema cache" wrapper. Either means operator_known_numbers hasn't
// been migrated on this environment yet. Mirrors the S25 permanent-training-
// loop fail-open pattern (src/lib/permanent/trainingExamples.ts), scoped down
// from "the whole table is missing" to "this one column is missing".
function isUndefinedColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

export async function saveTrainingHouse(
  payload: TrainingHousePayload,
): Promise<{ id: string } | { id: string; misses: KnownVsAiMiss[] } | null> {
  // Service client first so reads/writes bypass RLS (enabled on training_houses,
  // #90 — the table holds address + house-photo PII); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  const baseRow = {
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
  };

  // #109 Phase 2 — only reference operator_known_numbers at all when the
  // operator actually touched this feature (recorded a known count, or ran
  // Auto-Analyze). A legacy save that does neither never references the new
  // column, so it succeeds on the first attempt regardless of migration
  // status — the fail-open retry below only fires for saves that actually
  // carry ground-truth data.
  const known = payload.operatorKnownNumbers?.known;
  const aiSnapshot = payload.operatorKnownNumbers?.aiSnapshot;
  const shouldPersistKnownNumbers = Boolean(known || aiSnapshot);
  // The save-time readout only makes sense when there's something on BOTH
  // sides to compare — misses stays undefined (and is never returned to the
  // caller) when only one side is present.
  const hasReadout = Boolean(known && aiSnapshot);
  const misses = hasReadout ? compareKnownVsAi(known!, aiSnapshot!) : undefined;

  const operatorKnownNumbersForInsert: OperatorKnownNumbers | undefined = shouldPersistKnownNumbers
    ? {
        ...(known ? { known } : {}),
        ...(aiSnapshot ? { aiSnapshot } : {}),
        ...(misses ? { misses } : {}),
      }
    : undefined;

  const row = operatorKnownNumbersForInsert
    ? { ...baseRow, operator_known_numbers: operatorKnownNumbersForInsert }
    : baseRow;

  let { data, error } = await supabase.from('training_houses').insert(row).select('id').single();
  if (error && operatorKnownNumbersForInsert && isUndefinedColumnError(error)) {
    // FAIL-OPEN: operator_known_numbers hasn't been migrated on this
    // environment yet — retry without it so the rest of the save (photos,
    // footage, detections — everything this feature doesn't touch) still
    // succeeds. The computed `misses` above is still returned to the caller
    // for the save-time readout even though it wasn't persisted.
    console.error('saveTrainingHouse: operator_known_numbers column missing, retrying without it:', error.message);
    ({ data, error } = await supabase.from('training_houses').insert(baseRow).select('id').single());
  }

  if (error || !data) {
    console.error('saveTrainingHouse error:', JSON.stringify(error), error?.message);
    return null;
  }
  // Ground truth just landed (or a snapshot did) — the corpus-wide bias note
  // (getCorpusBiasNote) folds these in, so bust its cache the same way a
  // training_examples write does. No-op when this save never touched the
  // feature (shouldPersistKnownNumbers false) — nothing changed for the note.
  if (shouldPersistKnownNumbers) invalidateBiasNoteCache();
  return hasReadout ? { id: data.id, misses: misses! } : { id: data.id };
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

export type TrainingHouseGroundTruthPair = { known: KnownNumbers; aiSnapshot: AiSnapshot };

// #109 Phase 2 — the bias fold-in feed: training_houses rows that recorded
// BOTH operator ground truth AND an AI snapshot (see saveTrainingHouse).
// Consumed by trainingExamples.ts's getCorpusBiasNote, which folds these in
// as additional seed→final pairs alongside the training_examples corpus.
// Kept here since this file owns every training_houses read/write.
//
// FAIL-OPEN: the operator_known_numbers column may not be migrated on this
// environment yet — an undefined-column error degrades to [] (contributes
// nothing new to the bias note) rather than breaking bias-note computation
// for the whole corpus.
export async function getTrainingHouseGroundTruthPairs(limit = 200): Promise<TrainingHouseGroundTruthPair[]> {
  // Service client first so reads bypass RLS (enabled on training_houses, #90);
  // anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('training_houses')
    .select('operator_known_numbers')
    .not('operator_known_numbers', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isUndefinedColumnError(error)) return [];
    console.error('getTrainingHouseGroundTruthPairs error:', error);
    return [];
  }
  const pairs: TrainingHouseGroundTruthPair[] = [];
  for (const row of (data ?? []) as { operator_known_numbers: OperatorKnownNumbers | null }[]) {
    const okn = row.operator_known_numbers;
    if (okn?.known && okn?.aiSnapshot) pairs.push({ known: okn.known, aiSnapshot: okn.aiSnapshot });
  }
  return pairs;
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
