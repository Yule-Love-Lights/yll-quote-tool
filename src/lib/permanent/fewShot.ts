// #141 — the permanent-analyzer few-shot assembler + message builder. Mirrors
// src/lib/fewShot.ts's SIMILARITY-primary / RECENCY-fallback shape, but is a
// separate, satellite-primary pipeline for the permanent analyzer: the
// satellite image (not a street elevation) is both the analyzer's main input
// and the similarity key.
//
// While the library is small, "most-similar N" == "all of them", so this
// behaves like a recency feed and silently upgrades to real similarity
// retrieval as the library grows past the cap. No toggle, no cutover.

import {
  getRecentPermanentTrainingExamples,
  getSimilarPermanentTrainingExamples,
  type PermanentTrainingExampleRow,
} from './trainingExamples';
import { embedImage, isEmbeddingConfigured } from '../embeddings';
import { downscaleImageForVision } from '../photoAnalysis';
import type {
  PermanentSatelliteLines,
  PermanentStreetRun,
  PermanentJump,
  PermanentFewShotMessage,
} from './photoAnalysis';

// How many past houses to feed per analyze call. Smaller than holiday's 8 —
// each example carries at most 2 images (satellite + street) vs holiday's up
// to 4, and the corpus starts from zero, so a modest default keeps the first
// few calls cheap while still teaching from everything available.
export const PERMANENT_FEW_SHOT_LIMIT = 6;

// Sum-of-photos ceiling (mirrors holiday's TOTAL_FEW_SHOT_IMAGE_CAP): at most
// 2 photos/example × 6 examples = 12 worst case — cap a bit under that so a
// pathological run can't balloon the vision-token bill.
export const PERMANENT_TOTAL_IMAGE_CAP = 10;

// A stored row, projected to what buildPermanentFewShotMessages needs. `null`
// jumps/street fields collapse to safe defaults (empty array / undefined) —
// every row that reaches here already has a required satellite image.
export type PermanentFewShotExample = {
  satelliteBase64: string;
  satelliteMediaType: string;
  streetBase64?: string | null;
  streetMediaType?: string | null;
  satelliteFeetPerPixel?: number | null;
  finalSatelliteLines: PermanentSatelliteLines;
  finalStreetRuns: PermanentStreetRun[];
  // Jumps have no "corrected" source (the operator doesn't edit them
  // directly) — passed through from the AI's original pass, or [] when there
  // was none.
  jumps: PermanentJump[];
  // Staff-typed "what did the AI get wrong here?" note (row.notes, already
  // sanitized — capped + control-chars stripped — at write time by
  // trainingExamples.ts's sanitizeNotes). Mirrors holiday's aiFailureNotes.
  notes: string | null;
};

function asJumps(v: unknown): PermanentJump[] {
  return Array.isArray(v) ? (v as PermanentJump[]) : [];
}

// A stored row → the few-shot shape, or null when it has no usable satellite
// image (shouldn't happen — the column is NOT NULL — but stay defensive
// against a malformed/partial row). Pure — exported for tests.
export function rowToPermanentFewShot(row: PermanentTrainingExampleRow): PermanentFewShotExample | null {
  if (!row.satellite_photo_base64 || !row.satellite_media_type) return null;
  return {
    satelliteBase64: row.satellite_photo_base64,
    satelliteMediaType: row.satellite_media_type,
    streetBase64: row.street_photo_base64,
    streetMediaType: row.street_media_type,
    satelliteFeetPerPixel: row.satellite_feet_per_pixel,
    finalSatelliteLines: row.final_satellite_lines,
    finalStreetRuns: row.final_street_runs ?? [],
    jumps: asJumps((row.original_analysis as { jumps?: unknown } | null)?.jumps),
    notes: row.notes,
  };
}

function photoCount(e: PermanentFewShotExample): number {
  return 1 + (e.streetBase64 && e.streetMediaType ? 1 : 0);
}

// PURE cap on TOTAL few-shot photo count (mirrors capFewShotImages). `examples`
// is ordered least-relevant-first / most-relevant-LAST, so whole examples drop
// from the FRONT until the remaining photo sum fits the budget. Never drops
// the single most-relevant (last) example even if it alone exceeds the cap.
export function capPermanentFewShotImages(
  examples: PermanentFewShotExample[],
  imageCap: number,
): PermanentFewShotExample[] {
  const total = examples.reduce((sum, e) => sum + photoCount(e), 0);
  if (total <= imageCap) return examples;
  let running = total;
  let dropFrom = 0;
  while (dropFrom < examples.length - 1 && running > imageCap) {
    running -= photoCount(examples[dropFrom]);
    dropFrom++;
  }
  return examples.slice(dropFrom);
}

export type AssembledPermanentFewShot = {
  examples: PermanentFewShotExample[];
  ranking: 'similarity' | 'recency';
  // `degraded` = similarity was EXPECTED (Voyage configured) but we still
  // fell back to recency — a likely Voyage outage, not the legitimate
  // small-library/unconfigured case. Non-blocking signal for observability.
  breakdown: { count: number; ranking: 'similarity' | 'recency'; degraded: boolean };
};

// Fetch + rank + cap the few-shot for a permanent analyze call. `satelliteBase64`
// is the house currently being analyzed — embedded to drive similarity. FAIL-
// SAFE: any failure anywhere in this pipeline (embed, retrieval, projection)
// degrades to zero-shot ({ examples: [] }) rather than throwing — a broken
// few-shot library must never block the satellite analyzer.
export async function assemblePermanentFewShot(
  satelliteBase64: string,
  satelliteMediaType: string,
): Promise<AssembledPermanentFewShot> {
  try {
    const queryVec = await embedImage(satelliteBase64, satelliteMediaType, 'query');

    const project = (rows: PermanentTrainingExampleRow[]) =>
      rows.map(rowToPermanentFewShot).filter((e): e is PermanentFewShotExample => e != null);

    const similar = queryVec
      ? project(await getSimilarPermanentTrainingExamples(queryVec, PERMANENT_FEW_SHOT_LIMIT))
      : [];
    const usedSimilarity = similar.length > 0;
    const examples = usedSimilarity
      ? similar
      : project(await getRecentPermanentTrainingExamples(PERMANENT_FEW_SHOT_LIMIT));

    // Both retrieval paths return closest-or-newest FIRST; reverse so the
    // strongest example sits LAST (the model weights the end of context most —
    // same ordering contract as holiday's selectFewShot).
    const ordered = [...examples].reverse();
    const capped = capPermanentFewShotImages(ordered, PERMANENT_TOTAL_IMAGE_CAP);
    const ranking: 'similarity' | 'recency' = usedSimilarity ? 'similarity' : 'recency';

    const degraded = isEmbeddingConfigured() && !usedSimilarity;
    if (degraded) {
      console.warn('[assemblePermanentFewShot] similarity expected but fell back to recency — embed returned null or no rows projected');
    }

    return { examples: capped, ranking, breakdown: { count: capped.length, ranking, degraded } };
  } catch (err) {
    console.error('[assemblePermanentFewShot] failed — degrading to zero-shot:', err);
    return { examples: [], ranking: 'recency', breakdown: { count: 0, ranking: 'recency', degraded: false } };
  }
}

// Project confirmed examples into the analyzer's message shape: a user turn
// (label + satellite image, plus the street image when present) and an
// assistant turn whose text is EXACTLY the analyzer's JSON response shape —
// so the model learns to answer in the same format it's taught in.
export async function buildPermanentFewShotMessages(
  examples: PermanentFewShotExample[],
): Promise<PermanentFewShotMessage[]> {
  const messages: PermanentFewShotMessage[] = [];

  for (const ex of examples) {
    const userContent: PermanentFewShotMessage['content'] = [
      {
        type: 'text',
        text: 'Operator-confirmed permanent-lighting example from a sent quote — ground-truth roofline perimeter and street runs.',
      },
    ];

    const { base64: satBase64, mediaType: satMediaType } = await downscaleImageForVision(
      ex.satelliteBase64,
      ex.satelliteMediaType,
    );
    userContent.push({ type: 'image', source: { type: 'base64', media_type: satMediaType, data: satBase64 } });
    userContent.push({
      type: 'text',
      text: `^ tag: satellite${ex.satelliteFeetPerPixel ? ` — scale ${ex.satelliteFeetPerPixel.toFixed(4)} ft/px` : ''}`,
    });

    if (ex.streetBase64 && ex.streetMediaType) {
      const { base64: stBase64, mediaType: stMediaType } = await downscaleImageForVision(
        ex.streetBase64,
        ex.streetMediaType,
      );
      userContent.push({ type: 'image', source: { type: 'base64', media_type: stMediaType, data: stBase64 } });
      userContent.push({ type: 'text', text: '^ tag: street view — front-orientation cross-check' });
    }

    userContent.push({
      type: 'text',
      text: 'Trace the permanent-lighting roof perimeter for this house as the four side channels. Respond with JSON only.',
    });
    messages.push({ role: 'user', content: userContent });

    // Ground truth: lines from final_satellite_lines, streetRuns from
    // final_street_runs, jumps passed through from original_analysis (no
    // corrected source for jumps — empty array if none).
    const assistantPayload = {
      front: ex.finalSatelliteLines.front,
      left: ex.finalSatelliteLines.left,
      right: ex.finalSatelliteLines.right,
      back: ex.finalSatelliteLines.back,
      streetRuns: ex.finalStreetRuns,
      jumps: ex.jumps,
      // Mirrors photoAnalysis.ts's buildFewShotMessages: only inject a
      // pitfall line when a staff note was actually typed, so a null note
      // produces the same empty-string field it always has.
      // Mirrors photoAnalysis.ts's buildFewShotMessages: only inject a
      // pitfall line when a staff note was actually typed, so a null note
      // produces the same empty-string field it always has.
      notes: ex.notes ? `Known AI pitfall on this house: ${ex.notes}` : '',
      confidence: 'high',
    };
    messages.push({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(assistantPayload) }] });
  }

  return messages;
}
