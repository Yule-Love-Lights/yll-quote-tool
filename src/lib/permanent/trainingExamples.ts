// #141 — permanent-lighting training examples: the capture half of the
// PERMANENT AI feedback loop. Mirrors src/lib/trainingExamples.ts (#8 Stage A)
// architecturally (capture → embed → similarity retrieval → few-shot), but is
// a SEPARATE library with its own table (permanent_training_examples) — the
// two verticals teach two different analyzers with different ground-truth
// shapes (four satellite side channels vs the holiday santas/gingerbread
// split), so nothing here touches the holiday capture/few-shot code.
//
// Capture triggers (mirrors holiday's #8 Stage A call, Jason's S7 pattern —
// same BOTH):
//   'auto-send' — fired automatically when staff Send a PERMANENT quote.
//   'manual'    — the explicit "Save as training example" button.
// A quote keeps at most one example per source (unique index).
//
// FAIL-OPEN (this table's migration may not be applied yet on every
// environment the code ships to): every function below wraps its Supabase
// calls in try/catch and degrades to null/[]/false on ANY failure — including
// "relation does not exist" — so a missing table can never break quote send,
// analyze, or the review UI.

import { getSupabaseServiceClient } from '../supabase';
import { getDesign, downloadDesignImageBase64, type DesignRow } from '../designs';
import { getQuoteRaw } from '../quotes';
import { embedImage } from '../embeddings';
import { isStrand, type Scene, type SceneItem } from '../design/sceneTypes';
import type { PermanentQuoteFields } from './types';
import type { PermanentSatelliteLines, PermanentStreetRun } from './photoAnalysis';

export type PermanentTrainingExampleSource = 'auto-send' | 'manual';

const SIDES = ['front', 'left', 'right', 'back'] as const;
const STREET_SIDES = new Set(['front', 'left', 'right']);

// Context-only snapshot of the per-side footage/corners + accessories counts
// at capture time — NOT re-taught directly (the geometry is the lesson), just
// useful context for a human reviewing the example.
export type PermanentTrainingExampleInputs = {
  frontFootage: number;
  leftFootage: number;
  rightFootage: number;
  backFootage: number;
  frontCorners: number;
  leftCorners: number;
  rightCorners: number;
  backCorners: number;
  extensions?: { e3: number; e5: number; e10: number; e25: number };
  splittersNeeded?: number;
};

export type PermanentTrainingExampleRow = {
  id: string;
  created_at: string;
  updated_at: string;
  quote_id: string | null;
  design_id: string | null;
  source: PermanentTrainingExampleSource;
  excluded: boolean;
  notes: string | null;
  address: string | null;
  street_photo_base64: string | null;
  street_media_type: string | null;
  satellite_photo_base64: string;
  satellite_media_type: string;
  satellite_feet_per_pixel: number | null;
  original_analysis: Record<string, unknown> | null;
  final_satellite_lines: PermanentSatelliteLines;
  final_street_runs: PermanentStreetRun[] | null;
  final_inputs: PermanentTrainingExampleInputs | null;
};

// Light list shape for the review page — skips the big base64/jsonb columns.
export type PermanentTrainingExampleListItem = Omit<
  PermanentTrainingExampleRow,
  'street_photo_base64' | 'satellite_photo_base64' | 'original_analysis'
> & { has_street: boolean; has_analysis: boolean };

function getSb() {
  // Service-role: capture reads the private designs bucket and must work
  // regardless of anon policies. The table has RLS enabled with NO policies
  // (service-role bypasses RLS) — matches the #90 hardening on every table.
  return getSupabaseServiceClient();
}

function asNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// notes ride into a training/review context, not a live prompt today, but cap
// + strip control chars anyway (mirrors trainingExamples.ts's sanitizeNotes —
// cheap insurance against a huge/control-char payload).
const MAX_NOTES_LEN = 2000;
function sanitizeNotes(v: string | null | undefined): string | null {
  if (v == null) return null;
  return v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, MAX_NOTES_LEN) || null;
}

function sanitizePermanentInputs(p: Partial<PermanentQuoteFields>): PermanentTrainingExampleInputs {
  return {
    frontFootage: asNum(p.frontFootage),
    leftFootage: asNum(p.leftFootage),
    rightFootage: asNum(p.rightFootage),
    backFootage: asNum(p.backFootage),
    frontCorners: asNum(p.frontCorners),
    leftCorners: asNum(p.leftCorners),
    rightCorners: asNum(p.rightCorners),
    backCorners: asNum(p.backCorners),
    ...(p.extensions
      ? {
          extensions: {
            e3: asNum(p.extensions.e3),
            e5: asNum(p.extensions.e5),
            e10: asNum(p.extensions.e10),
            e25: asNum(p.extensions.e25),
          },
        }
      : {}),
    ...(typeof p.splittersNeeded === 'number' ? { splittersNeeded: asNum(p.splittersNeeded) } : {}),
  };
}

// The design's bulbType:'permanent' street strands → PermanentStreetRun[]
// (the confirmed street-visible runs). Pure — exported for tests. Points are
// stored in photo-PIXEL space on the strand item; normalized back to 0-1
// (the PermanentStreetRun contract) using the design's own photo dims.
//
// #249 review fix (provenance gate): `sideOfHouse` can be baked on by the
// editor's sticky pre-draw quick-tag (sideOfHouseAuto === true) rather than a
// deliberate per-strand choice — an operator can tag "Left", draw left runs,
// then keep drawing the front roofline on the SAME photo without switching
// bulb type/photo (the resets that clear the sticky default), silently
// mislabeling the front as left. This function's output feeds
// buildPermanentFewShotMessages (fewShot.ts) as "Operator-confirmed …
// ground-truth" with NO human review gate — captured automatically on every
// permanent-quote send — and the example pool is small enough that one wrong
// tag teaches ~every future analyze call. So: skip auto tags here: training
// ground truth only learns tags a human explicitly set or confirmed via the
// post-hoc #sel-side-of-house dropdown. The strand keeps its side for
// billing/display/the portal per-side toggle (sceneLinks.ts) either way —
// this filter is capture-only.
export function extractFinalStreetRuns(
  scene: Scene | null | undefined,
  photoW: number | null | undefined,
  photoH: number | null | undefined,
): PermanentStreetRun[] {
  if (!photoW || !photoH || photoW <= 0 || photoH <= 0) return [];
  const items: SceneItem[] = Array.isArray(scene?.items) ? scene.items : [];
  const runs: PermanentStreetRun[] = [];
  for (const item of items) {
    if (!isStrand(item) || item.bulbType !== 'permanent') continue;
    if (item.linkedToId) continue; // render-only twin — not a new run
    if (item.sideOfHouseAuto === true) continue; // unconfirmed sticky pre-draw tag — not ground truth
    const side = item.sideOfHouse;
    if (!side || !STREET_SIDES.has(side)) continue; // back never shows from the street
    const pts = item.points ?? [];
    if (pts.length < 4 || pts.length % 2 !== 0) continue;
    const points: [number, number][] = [];
    for (let i = 0; i < pts.length; i += 2) {
      points.push([clamp01(pts[i] / photoW), clamp01(pts[i + 1] / photoH)]);
    }
    runs.push({ side: side as PermanentStreetRun['side'], points, label: '' });
  }
  return runs;
}

// Assemble + save a training example for a permanent quote. Everything comes
// from persisted rows; returns null with a reason when the quote can't make a
// useful example (wrong service type / no linked design / no confirmed
// satellite lines / no satellite image).
export async function capturePermanentTrainingExample(opts: {
  quoteId: string;
  source: PermanentTrainingExampleSource;
  notes?: string | null;
}): Promise<{ id: string } | { error: string }> {
  const sb = getSb();
  if (!sb) return { error: 'Supabase service role not configured' };

  try {
    const quote = await getQuoteRaw(opts.quoteId);
    if (!quote) return { error: 'Quote not found' };
    // Positive gate — this library only ever teaches the permanent analyzer.
    if (quote.service_type !== 'permanent') return { error: 'Not a permanent quote' };

    const { data: designRef, error: designRefErr } = await sb
      .from('designs')
      .select('id')
      .eq('quote_id', opts.quoteId)
      .maybeSingle();
    if (designRefErr) {
      console.error('capturePermanentTrainingExample design lookup error:', designRefErr);
      return { error: 'Design lookup failed' };
    }
    if (!designRef) return { error: 'Quote has no linked design — nothing to capture' };

    const design: DesignRow | null = await getDesign(designRef.id as string);
    if (!design) return { error: 'Design not found' };

    const sat = design.satellite_lines;
    const finalSatelliteLines: PermanentSatelliteLines = {
      front: sat?.front ?? [],
      left: sat?.left ?? [],
      right: sat?.right ?? [],
      back: sat?.back ?? [],
    };
    const hasLines = SIDES.some((s) => finalSatelliteLines[s].length > 0);
    if (!hasLines) return { error: 'Design has no confirmed satellite lines yet — nothing to capture' };

    const satellite = await downloadDesignImageBase64(design.satellite_path ?? null);
    if (!satellite) return { error: 'Design has no satellite image — an example needs the satellite photo' };
    const street = await downloadDesignImageBase64(design.photo_path);

    const finalStreetRuns = extractFinalStreetRuns(design.scene, design.photo_w, design.photo_h);
    const permanentInputs = quote.inputs?.permanent;
    const finalInputs = permanentInputs ? sanitizePermanentInputs(permanentInputs) : null;

    // Embed the SATELLITE image (satellite-primary — the analyzer's main input
    // and the similarity key here, unlike holiday's street-photo key).
    // Graceful: null when Voyage is unconfigured or fails → the row is still
    // saved and falls back to recency until a later capture embeds it.
    const embedVec = await embedImage(satellite.base64, satellite.mediaType, 'document');

    const row = {
      quote_id: quote.id,
      design_id: design.id,
      // Refresh recency on a replace (re-send / re-save) — mirrors holiday.
      created_at: new Date().toISOString(),
      source: opts.source,
      notes: sanitizeNotes(opts.notes),
      address: quote.customer_address,
      street_photo_base64: street?.base64 ?? null,
      street_media_type: street?.mediaType ?? null,
      satellite_photo_base64: satellite.base64,
      satellite_media_type: satellite.mediaType,
      satellite_feet_per_pixel: design.satellite_feet_per_pixel ?? null,
      original_analysis: design.seed_analysis ?? null,
      final_satellite_lines: finalSatelliteLines,
      final_street_runs: finalStreetRuns,
      final_inputs: finalInputs,
      ...(embedVec ? { embedding: embedVec } : {}),
    };

    const { data, error } = await sb
      .from('permanent_training_examples')
      .upsert(row, { onConflict: 'quote_id,source' })
      .select('id')
      .single();
    if (error) {
      console.error('capturePermanentTrainingExample upsert error:', error);
      return { error: 'Failed to save the training example' };
    }
    return { id: data.id as string };
  } catch (err) {
    // FAIL-OPEN: covers the table not existing yet (migration not guaranteed
    // applied) and any other unexpected failure — capture must never throw
    // into the quote-send path.
    console.error('capturePermanentTrainingExample failed:', err);
    return { error: 'Capture failed' };
  }
}

// The few-shot feed (RECENCY): newest non-excluded examples, full payloads.
// The fallback ranker when similarity isn't available.
export async function getRecentPermanentTrainingExamples(limit = 8): Promise<PermanentTrainingExampleRow[]> {
  const sb = getSb();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('permanent_training_examples')
      .select('*')
      .eq('excluded', false)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('getRecentPermanentTrainingExamples error:', error);
      return [];
    }
    return (data ?? []) as PermanentTrainingExampleRow[];
  } catch (err) {
    console.error('getRecentPermanentTrainingExamples failed:', err);
    return [];
  }
}

// The few-shot feed (SIMILARITY): the non-excluded, embedded examples nearest
// the query (satellite) embedding, closest first. [] = fall back to recency
// (fresh/empty library, Voyage not configured, or the table doesn't exist yet).
export async function getSimilarPermanentTrainingExamples(
  queryEmbedding: number[],
  limit = 8,
): Promise<PermanentTrainingExampleRow[]> {
  const sb = getSb();
  if (!sb) return [];
  try {
    const { data, error } = await sb.rpc('match_permanent_training_examples', {
      query_embedding: queryEmbedding,
      match_count: limit,
    });
    if (error) {
      console.error('getSimilarPermanentTrainingExamples error:', error);
      return [];
    }
    return (data ?? []) as PermanentTrainingExampleRow[];
  } catch (err) {
    console.error('getSimilarPermanentTrainingExamples failed:', err);
    return [];
  }
}

export async function listPermanentTrainingExamples(limit = 200): Promise<PermanentTrainingExampleListItem[]> {
  const sb = getSb();
  if (!sb) return [];
  try {
    // The list stays LIGHT — never return the base64 photo columns just to
    // render badges. street_media_type is written together with
    // street_photo_base64, so it's a tiny exact proxy for "has street photo".
    const { data, error } = await sb
      .from('permanent_training_examples')
      .select(
        'id, created_at, updated_at, quote_id, design_id, source, excluded, notes, address, street_media_type, satellite_media_type, satellite_feet_per_pixel, final_satellite_lines, final_street_runs, final_inputs, original_analysis',
      )
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('listPermanentTrainingExamples error:', error);
      return [];
    }
    type Raw = Omit<PermanentTrainingExampleListItem, 'has_street' | 'has_analysis'> & {
      street_media_type: string | null;
      original_analysis: Record<string, unknown> | null;
    };
    return ((data ?? []) as Raw[]).map(({ original_analysis, ...r }) => ({
      ...r,
      has_street: r.street_media_type != null,
      has_analysis: original_analysis != null,
    }) as PermanentTrainingExampleListItem);
  } catch (err) {
    console.error('listPermanentTrainingExamples failed:', err);
    return [];
  }
}

export async function getPermanentTrainingExample(id: string): Promise<PermanentTrainingExampleRow | null> {
  const sb = getSb();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from('permanent_training_examples')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error('getPermanentTrainingExample error:', error);
      return null;
    }
    return (data as PermanentTrainingExampleRow | null) ?? null;
  } catch (err) {
    console.error('getPermanentTrainingExample failed:', err);
    return null;
  }
}

export async function updatePermanentTrainingExample(
  id: string,
  patch: { excluded?: boolean; notes?: string | null },
): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  try {
    const row: Record<string, unknown> = {};
    if (patch.excluded !== undefined) row.excluded = patch.excluded;
    if (patch.notes !== undefined) row.notes = sanitizeNotes(patch.notes);
    if (!Object.keys(row).length) return true;
    const { error } = await sb.from('permanent_training_examples').update(row).eq('id', id);
    if (error) {
      console.error('updatePermanentTrainingExample error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('updatePermanentTrainingExample failed:', err);
    return false;
  }
}

export async function deletePermanentTrainingExample(id: string): Promise<boolean> {
  const sb = getSb();
  if (!sb) return false;
  try {
    const { error } = await sb.from('permanent_training_examples').delete().eq('id', id);
    if (error) {
      console.error('deletePermanentTrainingExample error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('deletePermanentTrainingExample failed:', err);
    return false;
  }
}
