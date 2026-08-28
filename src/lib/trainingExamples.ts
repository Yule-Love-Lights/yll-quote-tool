// #8 Stage A — scene-based training examples: the capture half of the AI
// feedback loop. One example = one SELF-CONTAINED "the AI seeded X, staff
// corrected to Y" snapshot, assembled entirely server-side from persisted
// rows (quote inputs + the design's scene/photos/provenance) so capture
// works from a reopened quote with zero client state.
//
// Capture triggers (Jason's S7 call — BOTH):
//   'auto-send' — fired automatically when staff Send the quote (sending =
//                 vouching the design is right); re-sending REPLACES it.
//   'manual'    — the explicit "Save as training example" button.
// A quote keeps at most one example per source (partial unique index).
//
// These rows feed the analyzer's few-shot via exampleToFewShot() — the
// scene-based training library (the legacy photo_corrections system was
// retired; see migrations/2026-06-25-drop-photo-corrections.sql).

import { getSupabaseServiceClient } from './supabase';
import {
  getDesign,
  downloadDesignImageBase64,
  type DesignRow,
  type DesignScene,
  type DesignSatelliteLines,
} from './designs';
import { getQuoteRaw } from './quotes';
import { sceneToFewShotPieces } from './design/sceneToFewShot';
import { applyItemCorrections, type ItemCorrection } from './design/sceneCorrections';
import { embedImage } from './embeddings';
import { summarizeSeedFinalDiff } from './seedFinalDiff';
import { computeBiasSummary, formatBiasNote, type SeedFinalPair } from './seedFinalStats';
import type { FewShotExample, TrainingExamplePhoto } from './photoAnalysis';

export type TrainingExampleSource = 'auto-send' | 'manual';

// The measurement inputs the quote was actually priced with — the subset of
// QuoteInputs the analyzer teaches (roofline footage + difficulty).
export type TrainingExampleInputs = {
  santasFootage: number;
  santasDifficulty: 'easy' | 'medium' | 'hard';
  gingerbreadFootage: number;
  gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
  winterWonderlandFootage?: number;
  stakeLightingFootage?: number;
};

export type TrainingExampleRow = {
  id: string;
  created_at: string;
  quote_id: string | null;
  design_id: string | null;
  source: TrainingExampleSource;
  excluded: boolean;
  notes: string | null;
  address: string | null;
  street_photo_base64: string | null;
  street_media_type: string | null;
  street_w: number | null;
  street_h: number | null;
  satellite_base64: string | null;
  satellite_media_type: string | null;
  satellite_w: number | null;
  satellite_h: number | null;
  satellite_feet_per_pixel: number | null;
  satellite_lines: DesignSatelliteLines | null;
  original_analysis: Record<string, unknown> | null;
  // Fix round (PR #916): which ANALYZER_PROMPT_VERSION (src/lib/photoAnalysis.ts)
  // produced original_analysis. Null for rows captured before this column
  // existed, or where original_analysis predates the promptVersion field being
  // stamped onto analyzePhoto's result. See promptVersionOf() below for why
  // this is copied from original_analysis rather than stamped fresh here.
  prompt_version: string | null;
  final_scene: DesignScene;
  final_inputs: TrainingExampleInputs;
};

// Light list shape for the review page — skips the big base64 columns.
export type TrainingExampleListItem = Omit<
  TrainingExampleRow,
  'street_photo_base64' | 'satellite_base64' | 'original_analysis' | 'final_scene'
> & { has_satellite: boolean; has_analysis: boolean };

function getSb() {
  // Service-role: capture reads the private designs bucket and must work
  // regardless of anon policies. The table has RLS disabled (staff-side only).
  return getSupabaseServiceClient();
}

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

function asDifficulty(v: unknown): 'easy' | 'medium' | 'hard' {
  return typeof v === 'string' && DIFFICULTIES.has(v) ? (v as 'easy' | 'medium' | 'hard') : 'medium';
}

function asFootage(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

// Fix round (PR #916, admin lens MED): the prompt version that produced a
// captured example must be read from the analysis ITSELF (design.seed_analysis,
// stamped by analyzePhoto at generation time), never from the currently-live
// ANALYZER_PROMPT_VERSION constant at capture time. A design can be analyzed
// under one prompt and sent (captured, via 'auto-send') days or weeks later
// under a different one — stamping the live constant at capture time would
// silently mislabel that row's original_analysis with the WRONG prompt
// version, exactly the kind of error this column exists to prevent when
// comparing before/after a prompt change. null for legacy analyses that
// predate the promptVersion field.
function promptVersionOf(seedAnalysis: Record<string, unknown> | null | undefined): string | null {
  const v = seedAnalysis?.promptVersion;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// notes is stored uncapped and maps straight to aiFailureNotes, which is
// injected into EVERY analyze prompt as ground truth — a huge or control-char
// payload poisons the corpus text. training.ts's training_houses path added
// sanitizeCorpusText (2000-char cap + control-char strip) for exactly this
// reason (W5-028); training_examples never got it. That helper isn't exported
// from training.ts, so it's mirrored here rather than pulling in an unrelated
// file for this scoped fix.
const MAX_NOTES_LEN = 2000;
function sanitizeNotes(v: string | null | undefined): string | null {
  if (v == null) return null;
  return v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, MAX_NOTES_LEN) || null;
}

// Assemble + save a training example for a quote. Everything comes from
// persisted rows; returns null with a reason when the quote can't make a
// useful example (no linked design / no scene / no photo).
export async function captureTrainingExample(opts: {
  quoteId: string;
  source: TrainingExampleSource;
  notes?: string | null;
}): Promise<{ id: string } | { error: string }> {
  const sb = getSb();
  if (!sb) return { error: 'Supabase service role not configured' };

  const quote = await getQuoteRaw(opts.quoteId);
  if (!quote) return { error: 'Quote not found' };

  // The design linked to this quote (the partial unique index guarantees at
  // most one).
  const { data: designRef, error: designRefErr } = await sb
    .from('designs')
    .select('id')
    .eq('quote_id', opts.quoteId)
    .maybeSingle();
  if (designRefErr) {
    console.error('captureTrainingExample design lookup error:', designRefErr);
    return { error: 'Design lookup failed' };
  }
  if (!designRef) return { error: 'Quote has no linked design — nothing to capture' };

  const design: DesignRow | null = await getDesign(designRef.id as string);
  if (!design) return { error: 'Design not found' };

  const scene = design.scene;
  const hasItems = Array.isArray(scene?.items) && scene.items.length > 0;
  if (!hasItems) return { error: 'Design has no items yet — nothing to capture' };

  const street = await downloadDesignImageBase64(design.photo_path);
  if (!street) return { error: 'Design has no base photo — an example needs the street photo' };
  const satellite = await downloadDesignImageBase64(design.satellite_path ?? null);

  const inputs = quote.inputs ?? {};
  const finalInputs: TrainingExampleInputs = {
    santasFootage: asFootage(inputs.santasFootage),
    santasDifficulty: asDifficulty(inputs.santasDifficulty),
    gingerbreadFootage: asFootage(inputs.gingerbreadFootage),
    gingerbreadDifficulty: asDifficulty(inputs.gingerbreadDifficulty),
    ...(typeof inputs.winterWonderlandFootage === 'number'
      ? { winterWonderlandFootage: asFootage(inputs.winterWonderlandFootage) }
      : {}),
    ...(typeof inputs.stakeLightingFootage === 'number'
      ? { stakeLightingFootage: asFootage(inputs.stakeLightingFootage) }
      : {}),
  };

  // #8 Stage B — embed the street photo for similarity retrieval (graceful:
  // null when Voyage is unconfigured or fails → the row is still saved and
  // just falls back to recency until a later capture embeds it). Only INCLUDE
  // the column when we got a vector, so a transient Voyage failure on a
  // re-capture doesn't clobber a previously-good embedding (upsert only SETs
  // the columns present in the row).
  const embedVec = await embedImage(street.base64, street.mediaType, 'document');

  const row = {
    quote_id: quote.id,
    design_id: design.id,
    // Refresh recency on a replace (re-send / re-save): the upsert updates the
    // row in place, and the few-shot feed orders by created_at — without this,
    // a re-confirmed quote would never resurface in the "newest 2".
    created_at: new Date().toISOString(),
    source: opts.source,
    notes: sanitizeNotes(opts.notes),
    address: quote.customer_address,
    street_photo_base64: street.base64,
    street_media_type: street.mediaType,
    street_w: design.photo_w,
    street_h: design.photo_h,
    satellite_base64: satellite?.base64 ?? null,
    satellite_media_type: satellite?.mediaType ?? null,
    satellite_w: design.satellite_w ?? null,
    satellite_h: design.satellite_h ?? null,
    satellite_feet_per_pixel: design.satellite_feet_per_pixel ?? null,
    satellite_lines: design.satellite_lines ?? null,
    original_analysis: design.seed_analysis ?? null,
    prompt_version: promptVersionOf(design.seed_analysis),
    final_scene: scene,
    final_inputs: finalInputs,
    ...(embedVec ? { embedding: embedVec } : {}),
  };

  // Upsert on (quote_id, source): re-sending / re-saving replaces the prior
  // snapshot — the latest staff-confirmed state is the one worth learning.
  const { data, error } = await sb
    .from('training_examples')
    .upsert(row, { onConflict: 'quote_id,source' })
    .select('id')
    .single();
  if (error) {
    console.error('captureTrainingExample upsert error:', error);
    return { error: 'Failed to save the training example' };
  }
  invalidateBiasNoteCache();
  return { id: data.id as string };
}

// The few-shot feed (RECENCY): newest non-excluded examples, full payloads.
// The fallback ranker when similarity isn't available (no Voyage key / the
// query image didn't embed / no rows carry an embedding yet).
export async function getRecentTrainingExamples(limit = 2): Promise<TrainingExampleRow[]> {
  const sb = getSb();
  if (!sb) return [];
  const { data, error } = await sb
    .from('training_examples')
    .select('*')
    .eq('excluded', false)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('getRecentTrainingExamples error:', error);
    return [];
  }
  return (data ?? []) as TrainingExampleRow[];
}

// The few-shot feed (SIMILARITY, #8 Stage B): the non-excluded, embedded
// examples nearest the query embedding (cosine), closest first — the most
// visually-similar past houses. Returns [] when no rows are embedded yet
// (fresh/empty library, or Voyage not set up) so the caller falls back to
// recency. Uses the match_training_examples RPC from the Stage B migration.
export async function getSimilarTrainingExamples(
  queryEmbedding: number[],
  limit = 8,
): Promise<TrainingExampleRow[]> {
  const sb = getSb();
  if (!sb) return [];
  const { data, error } = await sb.rpc('match_training_examples', {
    query_embedding: queryEmbedding,
    match_count: limit,
  });
  if (error) {
    console.error('getSimilarTrainingExamples error:', error);
    return [];
  }
  return (data ?? []) as TrainingExampleRow[];
}

// Lightweight shape for similarity RANKING only -- no base64 image columns.
// A full TrainingExampleRow averages ~981 KB (street + satellite photos,
// measured live 2026-08-24); this shape averages ~7 KB (final_scene is jsonb,
// measured ~6.8 KB avg -- cheap enough that a maintained count column isn't
// needed). Used to widen the similarity candidate POOL for biasForMiniLights
// (fewShot.ts's MINI_BIAS_POOL_SIZE) without paying full-row bytes for
// candidates that get discarded immediately after ranking.
export type LiteTrainingExampleRow = {
  id: string;
  final_scene: DesignScene;
  street_w: number | null;
  street_h: number | null;
};

// Same ranking as getSimilarTrainingExamples (cosine distance, closest
// first), but via the sibling match_training_examples_lite RPC, which
// SELECTs only id/final_scene/street_w/street_h server-side -- the base64
// photo columns never cross the wire for this call. Never a substitute for
// getSimilarTrainingExamples: only enough to RANK + score mini-light
// richness; hydrate the final selected ids with getTrainingExamplesByIds.
export async function getSimilarTrainingExamplesLite(
  queryEmbedding: number[],
  limit = 8,
): Promise<LiteTrainingExampleRow[]> {
  const sb = getSb();
  if (!sb) return [];
  const { data, error } = await sb.rpc('match_training_examples_lite', {
    query_embedding: queryEmbedding,
    match_count: limit,
  });
  if (error) {
    console.error('getSimilarTrainingExamplesLite error:', error);
    return [];
  }
  return (data ?? []) as LiteTrainingExampleRow[];
}

// Hydrate a small, already-decided set of ids to full rows (base64 photos
// included) -- the second half of the rank-cheap/hydrate-only-the-winners
// split. `.in()` does NOT preserve the input id order; callers that care
// about similarity order (fewShot.ts does) must re-sort by their own id list.
export async function getTrainingExamplesByIds(ids: string[]): Promise<TrainingExampleRow[]> {
  const sb = getSb();
  if (!sb || ids.length === 0) return [];
  const { data, error } = await sb.from('training_examples').select('*').in('id', ids);
  if (error) {
    console.error('getTrainingExamplesByIds error:', error);
    return [];
  }
  return (data ?? []) as TrainingExampleRow[];
}

// #8 Stage C (C2): the corpus-wide systematic-bias calibration note for the
// analyzer prompt. Builds seed→final metric pairs across the seeded examples and
// aggregates them (see seedFinalStats). Returns null until there are enough
// seeded pairs to claim a tendency.
//
// W2-035: this pulls final_scene per row and re-projects every scene via
// sceneToFewShotPieces — corpus-wide, not query-specific, yet it was recomputed
// on EVERY analyze call. Memoized below with a short TTL + invalidated on any
// training_examples write in this module, so a burst of analyzes reuses one
// computation instead of re-querying/re-projecting the whole corpus each time.
const BIAS_SAMPLE_CAP = 200;
const BIAS_NOTE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let biasNoteCache: { note: string | null; expiresAt: number } | null = null;

// Drop the memoized note so the next getCorpusBiasNote() call recomputes from
// fresh rows. Called after every write to training_examples (capture/update/
// correct/delete) so the note never lags a real corpus change by more than
// one write; the TTL above is just the belt-and-suspenders fallback. Also
// exported test-only (mirrors rateLimit.ts's __bucketSize) so each test can
// start from a clean cache instead of leaking state across test files.
export function invalidateBiasNoteCache(): void {
  biasNoteCache = null;
}

async function computeCorpusBiasNote(): Promise<string | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb
    .from('training_examples')
    .select('original_analysis, final_inputs, final_scene, street_w, street_h')
    .eq('excluded', false)
    .not('original_analysis', 'is', null)
    .order('created_at', { ascending: false })
    .limit(BIAS_SAMPLE_CAP);
  if (error) {
    console.error('getCorpusBiasNote error:', error);
    return null;
  }
  type Row = Pick<TrainingExampleRow, 'original_analysis' | 'final_inputs' | 'final_scene' | 'street_w' | 'street_h'>;
  const pairs: SeedFinalPair[] = [];
  for (const r of (data ?? []) as Row[]) {
    // Detection counts come from the projected scene, which needs photo dims.
    if (!r.street_w || !r.street_h || r.street_w <= 0 || r.street_h <= 0) continue;
    const pieces = sceneToFewShotPieces(r.final_scene, r.street_w, r.street_h);
    pairs.push({
      seed: r.original_analysis,
      final: {
        santasFootage: r.final_inputs.santasFootage,
        gingerbreadFootage: r.final_inputs.gingerbreadFootage,
        santasDifficulty: r.final_inputs.santasDifficulty,
        gingerbreadDifficulty: r.final_inputs.gingerbreadDifficulty,
        miniLightDetections: pieces.miniLightDetections,
        wreathDetections: pieces.wreathDetections,
        spritzerDetections: pieces.spritzerDetections,
        garlandDetections: pieces.garlandDetections,
      },
    });
  }
  return formatBiasNote(computeBiasSummary(pairs));
}

export async function getCorpusBiasNote(): Promise<string | null> {
  const now = Date.now();
  if (biasNoteCache && biasNoteCache.expiresAt > now) return biasNoteCache.note;
  const note = await computeCorpusBiasNote();
  biasNoteCache = { note, expiresAt: now + BIAS_NOTE_TTL_MS };
  return note;
}

export async function listTrainingExamples(limit = 200): Promise<TrainingExampleListItem[]> {
  const sb = getSb();
  if (!sb) return [];
  // The list must stay LIGHT — never RETURN the big base64 / full-analysis
  // columns just to render badges. satellite_media_type is written together
  // with satellite_base64 (both from downloadDesignImageBase64), so it's an
  // exact, tiny proxy for "has satellite". original_analysis IS selected
  // (W2-036: one query instead of a second full-table query just for this
  // boolean) but is stripped from every returned item right below — has_analysis
  // is derived from it and the jsonb payload itself never leaves this function.
  const { data, error } = await sb
    .from('training_examples')
    .select(
      'id, created_at, quote_id, design_id, source, excluded, notes, address, street_media_type, street_w, street_h, satellite_media_type, satellite_w, satellite_h, satellite_feet_per_pixel, satellite_lines, final_inputs, original_analysis',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listTrainingExamples error:', error);
    return [];
  }

  type Raw = Omit<TrainingExampleListItem, 'has_satellite' | 'has_analysis'> & {
    satellite_media_type: string | null;
    original_analysis: Record<string, unknown> | null;
  };
  return ((data ?? []) as Raw[]).map(({ original_analysis, ...r }) => ({
    ...r,
    has_satellite: r.satellite_media_type != null,
    has_analysis: original_analysis != null,
  }) as TrainingExampleListItem);
}

// Uncapped count of rows eligible for the placement eval, so
// scripts/eval-placement.ts can tell whether listTrainingExamples' fetch
// limit silently truncated the corpus. Mirrors the SAME eligibility that
// script's own `!r.excluded && r.has_analysis && r.street_w && r.street_h`
// filter applies, done server-side with a head:true count query (no rows
// transferred) instead of a second full fetch. (street_w/street_h use
// `.not(is,null)` rather than the script's truthy check, so a literal 0 --
// not a real photo dimension -- would count here and not there; harmless in
// practice and noted rather than hidden.)
export async function countEligiblePlacementExamples(): Promise<number | null> {
  const sb = getSb();
  if (!sb) return null;
  const { count, error } = await sb
    .from('training_examples')
    .select('id', { count: 'exact', head: true })
    .eq('excluded', false)
    .not('original_analysis', 'is', null)
    .not('street_w', 'is', null)
    .not('street_h', 'is', null);
  if (error) {
    console.error('countEligiblePlacementExamples error:', error);
    return null;
  }
  return count;
}

export async function getTrainingExample(id: string): Promise<TrainingExampleRow | null> {
  const sb = getSb();
  if (!sb) return null;
  const { data, error } = await sb
    .from('training_examples')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('getTrainingExample error:', error);
    return null;
  }
  return (data as TrainingExampleRow | null) ?? null;
}

export async function updateTrainingExample(
  id: string,
  patch: { excluded?: boolean; notes?: string | null },
): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const row: Record<string, unknown> = {};
  if (patch.excluded !== undefined) row.excluded = patch.excluded;
  if (patch.notes !== undefined) row.notes = sanitizeNotes(patch.notes);
  if (!Object.keys(row).length) return true;
  const { error } = await sb.from('training_examples').update(row).eq('id', id);
  if (error) {
    console.error('updateTrainingExample error:', error);
    return false;
  }
  invalidateBiasNoteCache();
  return true;
}

function sanitizeTrainingInputs(inputs: TrainingExampleInputs): TrainingExampleInputs {
  return {
    santasFootage: asFootage(inputs.santasFootage),
    santasDifficulty: asDifficulty(inputs.santasDifficulty),
    gingerbreadFootage: asFootage(inputs.gingerbreadFootage),
    gingerbreadDifficulty: asDifficulty(inputs.gingerbreadDifficulty),
    ...(typeof inputs.winterWonderlandFootage === 'number'
      ? { winterWonderlandFootage: asFootage(inputs.winterWonderlandFootage) }
      : {}),
    ...(typeof inputs.stakeLightingFootage === 'number'
      ? { stakeLightingFootage: asFootage(inputs.stakeLightingFootage) }
      : {}),
  };
}

// #52 — staff correction of a saved example: fix the roofline footage/difficulty
// (final_inputs) and/or per-item detections (final_scene — mini strand counts,
// spritzer/wreath size, wreath/garland tier, garland length). Only the addressed
// items' valid fields change; everything else in the scene is preserved verbatim.
// No re-embed/recompute — the few-shot derives detections from final_scene live
// at analyze time.
export async function correctTrainingExample(
  id: string,
  patch: { finalInputs?: TrainingExampleInputs; itemCorrections?: Record<string, ItemCorrection> },
): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const row: Record<string, unknown> = {};

  if (patch.finalInputs) {
    row.final_inputs = sanitizeTrainingInputs(patch.finalInputs);
  }

  const corrections = patch.itemCorrections;
  if (corrections && Object.keys(corrections).length) {
    const current = await getTrainingExample(id);
    if (!current) return false;
    row.final_scene = applyItemCorrections(current.final_scene, corrections);
  }

  if (!Object.keys(row).length) return true;
  const { error } = await sb.from('training_examples').update(row).eq('id', id);
  if (error) {
    console.error('correctTrainingExample error:', error);
    return false;
  }
  invalidateBiasNoteCache();
  return true;
}

export async function deleteTrainingExample(id: string): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  const { error } = await sb.from('training_examples').delete().eq('id', id);
  if (error) {
    console.error('deleteTrainingExample error:', error);
    return false;
  }
  invalidateBiasNoteCache();
  return true;
}

// A stored example → the analyzer's few-shot shape, or NULL when it can't be a
// trustworthy example. The final scene supplies the "corrected" roofline
// polylines + detections; the satellite image (when it has confirmed lines)
// rides along so the model finally SEES satellite examples.
//
// Returns null when:
//  - the street photo or its pixel dims are missing — without dims the scene
//    can't be projected to normalized coords, so we'd otherwise teach EMPTY
//    roofline lines alongside nonzero footage (a corrupt lesson), or
//  - the street photo itself is missing (nothing for the model to look at).
export function exampleToFewShot(row: TrainingExampleRow): FewShotExample | null {
  if (!row.street_photo_base64 || !row.street_media_type) return null;
  if (!row.street_w || !row.street_h || row.street_w <= 0 || row.street_h <= 0) return null;

  const pieces = sceneToFewShotPieces(row.final_scene, row.street_w, row.street_h);
  const photos: TrainingExamplePhoto[] = [
    { base64: row.street_photo_base64, mediaType: row.street_media_type, tag: 'front_install' },
  ];

  // Satellite half stays COHERENT: only teach the satellite image together
  // with its confirmed measurement lines. A scale-less manual satellite with
  // no traced lines has layout value but no measurement truth — including it
  // would teach "empty satellite arrays for a visible top-down". Skip it.
  //
  // The reverse gap also needs guarding: QuoteBuilder can push traced satellite
  // LINES with no derived footage at all (satelliteFeetPerPixel null → the
  // *Footage keys are omitted entirely from satellite_lines). buildFewShotMessages
  // then coerces the missing footage to 0, which would teach "traced real
  // lines, report 0 ft" — biasing the model toward under-measurement. Require
  // at least one positive derived footage before teaching the satellite half.
  const sat = row.satellite_lines;
  const satHasLines = (sat?.santas?.length ?? 0) > 0 || (sat?.gingerbread?.length ?? 0) > 0;
  const satHasFootage =
    (typeof sat?.santasFootage === 'number' && sat.santasFootage > 0) ||
    (typeof sat?.gingerbreadFootage === 'number' && sat.gingerbreadFootage > 0);
  const includeSatellite = Boolean(
    row.satellite_base64 && row.satellite_media_type && satHasLines && satHasFootage,
  );
  if (includeSatellite) {
    photos.push({
      base64: row.satellite_base64!,
      mediaType: row.satellite_media_type!,
      tag: 'satellite',
      caption: row.satellite_feet_per_pixel
        ? `top-down satellite — scale ${row.satellite_feet_per_pixel.toFixed(4)} ft/px`
        : 'top-down satellite (no known scale)',
    });
  }

  // #8 Stage C (C1): the seed→final correction note (null when the design
  // carried no AI seed). Compares the AI's first pass (original_analysis) to the
  // staff-corrected final, both in analyzer vocabulary.
  const seedDiffNote = summarizeSeedFinalDiff(row.original_analysis, {
    santasFootage: row.final_inputs.santasFootage,
    gingerbreadFootage: row.final_inputs.gingerbreadFootage,
    santasDifficulty: row.final_inputs.santasDifficulty,
    gingerbreadDifficulty: row.final_inputs.gingerbreadDifficulty,
    miniLightDetections: pieces.miniLightDetections,
    wreathDetections: pieces.wreathDetections,
    spritzerDetections: pieces.spritzerDetections,
    garlandDetections: pieces.garlandDetections,
    satelliteSantasFootage: includeSatellite ? sat?.santasFootage : undefined,
  });

  return {
    photos,
    santasFootage: row.final_inputs.santasFootage,
    santasDifficulty: row.final_inputs.santasDifficulty,
    santasLines: pieces.santasLines,
    gingerbreadFootage: row.final_inputs.gingerbreadFootage,
    gingerbreadDifficulty: row.final_inputs.gingerbreadDifficulty,
    gingerbreadLines: pieces.gingerbreadLines,
    // Only emit satellite lines when the satellite image is actually shown —
    // otherwise the model would learn coordinates for an image it never saw.
    satelliteSantasLines: includeSatellite ? sat?.santas ?? [] : [],
    satelliteSantasFootage: includeSatellite ? sat?.santasFootage : undefined,
    satelliteGingerbreadLines: includeSatellite ? sat?.gingerbread ?? [] : [],
    satelliteGingerbreadFootage: includeSatellite ? sat?.gingerbreadFootage : undefined,
    miniLightDetections: pieces.miniLightDetections,
    wreathDetections: pieces.wreathDetections,
    spritzerDetections: pieces.spritzerDetections,
    garlandDetections: pieces.garlandDetections,
    aiFailureNotes: row.notes,
    seedDiffNote,
    source: 'design',
  };
}
