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

// Mini-light detection (bush/tree/column/railing wraps) is the analyzer's
// WORST surface — measured across the live 42-example corpus: 38% exact
// count match / 2.50 avg count miss, worse than wreaths (55%/0.83), spritzers
// (50%/1.38), or roofline segments. Whole-photo similarity retrieval has no
// way to prefer examples that actually carry comparable mini-light ground
// truth — a house can be matched on siding/framing/style to 8 examples that
// between them have almost no wrapped bushes/trees to teach from. Reserve a
// SMALL minority of the few-shot slots for the richest mini-light examples
// found beyond the pure-similarity core (see biasForMiniLights below), so the
// model always sees calibrated strand counts and box placements without
// displacing the majority of genuinely-closest-match teaching (rooflines,
// wreaths, spritzers, garland). 2 of 8 (25%) guarantees real mini-light
// signal on every call while leaving 75% of slots fully similarity-driven.
export const MINI_RESERVED_SLOTS = 2;

// How many similarity candidates to fetch before biasing — must exceed
// FEW_SHOT_LIMIT or there's no pool beyond the pure-similarity core to search
// for mini-rich rows in. 3x FEW_SHOT_LIMIT leaves real room to find them
// without scoring the whole corpus (44 rows today) on every analyze call.
export const MINI_BIAS_POOL_SIZE = FEW_SHOT_LIMIT * 3;

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

// How "rich" in mini-light ground truth one candidate is — just the detection
// COUNT (locations to teach box placement from), matching the metric this was
// measured against (exact-count match / avg count miss). Not weighted by
// stringCount: a house with 4 sparsely-strung locations is still more useful
// to teach FROM than a house with 0.
function miniLightRichness(example: FewShotExample): number {
  return example.miniLightDetections.length;
}

// PURE: bias a similarity-ordered candidate pool (closest-first) toward
// examples with real mini-light ground truth, WITHOUT displacing the
// pure-similarity "core" (the true closest matches, which anchor the
// strongest teaching signal — selectFewShot puts the closest match LAST,
// i.e. most-weighted). Reserves `reservedSlots` of the final `limit` for the
// most mini-light-rich candidates found beyond that core, so the model sees
// calibrated mini strand counts/boxes even when the closest-LOOKING houses
// happen to have none. Falls back to plain similarity order (a no-op) when
// there's no pool to search (candidates already ≤ limit), reservation is
// off, or nothing beyond the core has any mini-light detections at all.
export function biasForMiniLights(
  candidates: FewShotExample[],
  limit: number,
  reservedSlots: number,
): FewShotExample[] {
  if (candidates.length <= limit || reservedSlots <= 0) return candidates.slice(0, limit);
  const reserved = Math.min(reservedSlots, limit);
  const coreCount = limit - reserved;
  const core = candidates.slice(0, coreCount);
  const pool = candidates.slice(coreCount);

  const richPicks = pool
    .map((example, idx) => ({ example, idx, richness: miniLightRichness(example) }))
    .filter((c) => c.richness > 0)
    // Richest first; ties go to the more-similar (lower original index) candidate.
    .sort((a, b) => b.richness - a.richness || a.idx - b.idx)
    .slice(0, reserved)
    .map((c) => c.example);

  const picked = new Set<FewShotExample>([...core, ...richPicks]);
  // Top up any reserved slots richPicks couldn't fill (fewer mini-rich rows
  // than reservedSlots) with the next most-similar unused pool candidates —
  // pool always has > reservedSlots entries here, so this always reaches
  // `limit`. Filtering the ORIGINAL candidates array (not core/richPicks
  // directly) keeps the output in similarity order.
  for (const c of pool) {
    if (picked.size >= limit) break;
    picked.add(c);
  }
  return candidates.filter((c) => picked.has(c));
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
  // Fetch a larger similarity pool (MINI_BIAS_POOL_SIZE) than the final
  // FEW_SHOT_LIMIT so biasForMiniLights has real candidates beyond the
  // pure-similarity core to search for mini-light-rich rows in.
  const similarDesign = queryVec
    ? biasForMiniLights(
        projectDesign(await getSimilarTrainingExamples(queryVec, MINI_BIAS_POOL_SIZE)),
        FEW_SHOT_LIMIT,
        MINI_RESERVED_SLOTS,
      )
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
