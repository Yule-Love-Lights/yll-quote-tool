// #8 Stage B — the unified few-shot assembler shared by both analyze routes
// (previously this block was duplicated verbatim in analyze-photo + analyze-
// address). ONE retrieval pipeline:
//
//   • SIMILARITY (primary): embed the incoming house photo (Voyage) and pull
//     the most visually-similar past examples from pgvector.
//   • RECENCY (automatic fallback): used when there's no Voyage key, the query
//     image doesn't embed, or no example is embedded yet (fresh library).
//
// While the library is small, "most-similar N" == "all of them", so this
// behaves like a recency feed and silently upgrades to real similarity
// retrieval as the library grows past the cap. No toggle, no cutover.

import {
  exampleToFewShot,
  getRecentTrainingExamples,
  getSimilarTrainingExamples,
  getCorpusBiasNote,
  type TrainingExampleRow,
} from './trainingExamples';
import { getTrainingFewShot, type StoredTrainingHouse } from './training';
import { getReferenceAssetsForAnalysis, type StoredReferenceAsset } from './referenceAssets';
import { embedImage, isEmbeddingConfigured } from './embeddings';
import { type FewShotExample } from './photoAnalysis';

// The one tunable knob: how many house examples to feed per analyze call.
// 8 is the few-shot sweet spot — past it returns diminish and latency (image
// tokens) grows. Bump/lower here; nothing else changes.
export const FEW_SHOT_LIMIT = 8;

// Product reference close-ups (wreath/spritzer/garland) are separate from house
// EXAMPLES and don't count toward FEW_SHOT_LIMIT.
const REFERENCE_PER_TYPE = 2;

// W5-008 (#110 wave 5): FEW_SHOT_LIMIT caps the number of EXAMPLES (up to 8),
// but each training-house example can carry up to 4 photos — worst case that's
// 32 few-shot images, plus up to 6 reference images (REFERENCE_PER_TYPE × 3
// asset types), plus the house photo (+ satellite) itself: ~40 images / ~64K
// vision tokens with no TOTAL ceiling. Cap the sum of few-shot example PHOTOS
// (references are already small and fixed) so a worst-case call can't balloon
// past a sane image budget, while keeping the most relevant examples — the
// ones `selectFewShot` weights most (closest match, ordered LAST).
export const TOTAL_FEW_SHOT_IMAGE_CAP = 24;

// A training-house DB row → the analyzer's few-shot shape. Up to 4 photos
// (front_install first, then alt angles), confirmed measurements + detections.
function trainingHouseToExample(h: StoredTrainingHouse): FewShotExample {
  const ordered = [...h.photos].sort((a, b) => {
    const order: Record<string, number> = {
      front_install: 0, front_takedown: 1, side: 2, detail: 3, back: 4, satellite: 5, other: 6,
    };
    return (order[a.tag] ?? 9) - (order[b.tag] ?? 9);
  }).slice(0, 4);
  return {
    photos: ordered.map(p => ({ base64: p.base64, mediaType: p.mediaType, tag: p.tag, caption: p.caption })),
    santasFootage: h.santas_footage!,
    santasDifficulty: h.santas_difficulty ?? 'medium',
    santasLines: h.santas_lines ?? [],
    gingerbreadFootage: h.gingerbread_footage!,
    gingerbreadDifficulty: h.gingerbread_difficulty ?? 'medium',
    gingerbreadLines: h.gingerbread_lines ?? [],
    miniLightDetections: h.mini_light_detections ?? [],
    wreathDetections: h.wreath_detections ?? [],
    spritzerDetections: h.spritzer_detections ?? [],
    garlandDetections: h.garland_detections ?? [],
    houseStyle: h.house_style ?? undefined,
    aiFailureNotes: h.ai_failure_notes,
    source: 'training',
  };
}

export type FewShotSources = {
  design: FewShotExample[];      // scene-based examples, ranked best-first (similarity or recency)
  training: FewShotExample[];    // confirmed training houses, recency/style-ranked
};

// PURE: pick ≤ limit examples and ORDER them best-last. Design fills the cap
// first, then training pads any remaining slots. Output order matters: the
// model weights the END of the context most (and the very start; "lost in the
// middle"), so the strongest example sits LAST. `design` arrives best-first
// (closest match first), so it's REVERSED to put the closest match dead last;
// lower-trust training goes earlier.
export function selectFewShot(sources: FewShotSources, limit: number): FewShotExample[] {
  const design = sources.design.slice(0, limit);
  const training = sources.training.slice(0, Math.max(0, limit - design.length));
  // Earliest (least weight) → latest (most weight): training, then design with
  // its closest match last.
  return [...training, ...[...design].reverse()];
}

// W5-008 (#110 wave 5): PURE cap on TOTAL few-shot photo count (not example
// count — FEW_SHOT_LIMIT already caps that). `examples` is ordered least-
// weighted-first / most-relevant-LAST (selectFewShot's contract), so drop
// whole examples from the FRONT until the remaining photo sum fits the
// budget. Never drops the single most-relevant (last) example even if it
// alone exceeds the cap — a truncated few-shot set beats an empty one.
export function capFewShotImages(
  examples: FewShotExample[],
  imageCap: number,
): FewShotExample[] {
  const total = examples.reduce((sum, e) => sum + e.photos.length, 0);
  if (total <= imageCap) return examples;
  let running = total;
  let dropFrom = 0;
  while (dropFrom < examples.length - 1 && running > imageCap) {
    running -= examples[dropFrom].photos.length;
    dropFrom++;
  }
  return examples.slice(dropFrom);
}

export type AssembledFewShot = {
  examples: FewShotExample[];
  references: StoredReferenceAsset[];
  ranking: 'similarity' | 'recency';
  // #8 Stage C (C2): corpus-wide systematic-bias calibration for the system
  // prompt, or null when the corpus is too small to claim a tendency.
  biasNote: string | null;
  // `degraded` = similarity was EXPECTED (Voyage configured + a query image
  // present) but we still fell back to recency (embed returned null or no
  // similar rows projected) — i.e. a likely Voyage outage, NOT the legitimate
  // small-library/unconfigured case. Non-blocking signal for the UI.
  breakdown: { design: number; training: number; references: number; ranking: 'similarity' | 'recency'; degraded: boolean };
};

// Fetch + rank + cap the few-shot for an analyze call. `queryImage` is the
// house being analyzed (street photo) — embedded to drive similarity. Omit it
// (or leave Voyage unconfigured) to force the recency fallback.
export async function assembleFewShot(
  houseStyleHint: string | undefined,
  queryImage: { base64: string; mediaType: string } | undefined,
): Promise<AssembledFewShot> {
  // W5-022 (#110 wave 5, perf): references + the corpus-bias note depend on
  // NEITHER the query embedding nor the design/training selection below —
  // start them immediately instead of waiting on the embed→similarity chain
  // to finish first. (getTrainingFewShot can't join this Promise.all — W5-009
  // below needs `design.length` to decide whether to call it at all.)
  const referencesPromise = getReferenceAssetsForAnalysis(REFERENCE_PER_TYPE);
  const biasNotePromise = getCorpusBiasNote();

  // 1. Embed the query house (null when no image / Voyage unconfigured / fails).
  const queryVec = queryImage
    ? await embedImage(queryImage.base64, queryImage.mediaType, 'query')
    : null;

  // 2. Design examples: similarity if the query embedded AND the nearest rows
  //    actually PROJECT. A row can be embedded yet non-projectable (missing
  //    photo dims), so we decide on the PROJECTED count — otherwise a top-K of
  //    non-projectable rows would yield an empty design slice mislabeled
  //    'similarity', never recovering to recency.
  const projectDesign = (rows: TrainingExampleRow[]) =>
    rows.map(exampleToFewShot).filter((e): e is FewShotExample => e != null);
  const similarDesign = queryVec
    ? projectDesign(await getSimilarTrainingExamples(queryVec, FEW_SHOT_LIMIT))
    : [];
  const usedSimilarity = similarDesign.length > 0;
  const design = usedSimilarity
    ? similarDesign
    : projectDesign(await getRecentTrainingExamples(FEW_SHOT_LIMIT));

  // 3. Training houses (unless skipped) + the already-in-flight sources above.
  // W5-009 (#110 wave 5): selectFewShot fills design first, then pads with
  // training only for the slots design didn't fill (Math.max(0, limit -
  // design.length)) — so once design already fills every slot, the training
  // fetch's result is guaranteed to be sliced to 0 and discarded. Skip the
  // fetch entirely in that case.
  const designFillsAllSlots = design.length >= FEW_SHOT_LIMIT;
  const [trainingHouses, references, biasNote] = await Promise.all([
    designFillsAllSlots ? Promise.resolve([]) : getTrainingFewShot(FEW_SHOT_LIMIT, houseStyleHint),
    referencesPromise,
    biasNotePromise,
  ]);

  // 4. Map the remaining sources to the few-shot shape.
  const training = trainingHouses
    .filter(h => h.photos?.length && h.santas_footage != null && h.gingerbread_footage != null)
    .map(trainingHouseToExample);

  // 5. Select + order, then cap the TOTAL photo count (W5-008) — selectFewShot
  // already orders least-relevant-first, so the cap trims from the front.
  const selected = selectFewShot({ design, training }, FEW_SHOT_LIMIT);
  const examples = capFewShotImages(selected, TOTAL_FEW_SHOT_IMAGE_CAP);
  const ranking: 'similarity' | 'recency' = usedSimilarity ? 'similarity' : 'recency';

  // Audit fix (Finding #57): the recency fallback is silent — indistinguishable
  // from the legitimate unconfigured/small-library case. If a query image was
  // given AND Voyage IS configured yet we still fell back, similarity was
  // expected (likely a Voyage outage or all-non-projectable rows). Surface it
  // so estimate quality doesn't quietly degrade. Fallback still succeeds.
  const degraded = !!queryImage && isEmbeddingConfigured() && !usedSimilarity;
  if (degraded) {
    console.warn('[assembleFewShot] similarity expected but fell back to recency — embed returned null or no rows projected');
  }

  return {
    examples,
    references,
    ranking,
    biasNote,
    breakdown: {
      design: design.length,
      training: training.length,
      references: references.length,
      ranking,
      degraded,
    },
  };
}
