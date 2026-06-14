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
// These rows feed the analyzer's few-shot via exampleToFewShot(), taking
// precedence over the legacy photo_corrections (which only fill remaining
// slots until Jason's planned full data wipe retires them).

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
      ? { winterWonderlandFootage: inputs.winterWonderlandFootage }
      : {}),
  };

  const row = {
    quote_id: quote.id,
    design_id: design.id,
    // Refresh recency on a replace (re-send / re-save): the upsert updates the
    // row in place, and the few-shot feed orders by created_at — without this,
    // a re-confirmed quote would never resurface in the "newest 2".
    created_at: new Date().toISOString(),
    source: opts.source,
    notes: opts.notes ?? null,
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
    final_scene: scene,
    final_inputs: finalInputs,
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
  return { id: data.id as string };
}

// The few-shot feed: newest non-excluded examples, full payloads.
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

export async function listTrainingExamples(limit = 200): Promise<TrainingExampleListItem[]> {
  const sb = getSb();
  if (!sb) return [];
  // The list must stay LIGHT — never select the big base64 / full-analysis
  // columns just to render badges. satellite_media_type is written together
  // with satellite_base64 (both from downloadDesignImageBase64), so it's an
  // exact, tiny proxy for "has satellite". For "has analysis" we select a
  // boolean-ish proxy: original_analysis is jsonb, but PostgREST can't compute
  // `is not null` in select — so we fetch the (small) media types only and
  // derive has_analysis from a dedicated cheap query below.
  const { data, error } = await sb
    .from('training_examples')
    .select(
      'id, created_at, quote_id, design_id, source, excluded, notes, address, street_media_type, street_w, street_h, satellite_media_type, satellite_w, satellite_h, satellite_feet_per_pixel, satellite_lines, final_inputs',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listTrainingExamples error:', error);
    return [];
  }
  // Cheap id-set of rows that actually carry an AI analysis (no payload pulled).
  const withAnalysis = new Set<string>();
  const { data: idRows } = await sb
    .from('training_examples')
    .select('id')
    .not('original_analysis', 'is', null)
    .limit(limit);
  for (const r of (idRows ?? []) as { id: string }[]) withAnalysis.add(r.id);

  type Raw = Omit<TrainingExampleListItem, 'has_satellite' | 'has_analysis'> & {
    satellite_media_type: string | null;
  };
  return ((data ?? []) as Raw[]).map((r) => ({
    ...r,
    has_satellite: r.satellite_media_type != null,
    has_analysis: withAnalysis.has(r.id),
  }) as TrainingExampleListItem);
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
  if (patch.notes !== undefined) row.notes = patch.notes;
  if (!Object.keys(row).length) return true;
  const { error } = await sb.from('training_examples').update(row).eq('id', id);
  if (error) {
    console.error('updateTrainingExample error:', error);
    return false;
  }
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
  const sat = row.satellite_lines;
  const satHasLines = (sat?.santas?.length ?? 0) > 0 || (sat?.gingerbread?.length ?? 0) > 0;
  const includeSatellite = Boolean(row.satellite_base64 && row.satellite_media_type && satHasLines);
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
    source: 'design',
  };
}
