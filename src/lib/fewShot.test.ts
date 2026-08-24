import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  selectFewShot,
  FEW_SHOT_LIMIT,
  capFewShotImages,
  TOTAL_FEW_SHOT_IMAGE_CAP,
  biasForMiniLights,
  MINI_RESERVED_SLOTS,
  MINI_BIAS_POOL_SIZE,
} from './fewShot';
import type { FewShotExample, TrainingExamplePhoto, MiniLightDetection } from './photoAnalysis';

// --- Mocks for assembleFewShot's dependencies (audit Finding #57) ---------
// Keep every collaborator inert so we can isolate the embed → similarity →
// recency-fallback decision and the degraded signal it should now emit.
vi.mock('./embeddings', () => ({
  embedImage: vi.fn(),
  isEmbeddingConfigured: vi.fn(),
}));
vi.mock('./trainingExamples', () => ({
  exampleToFewShot: vi.fn(() => null),
  getRecentTrainingExamples: vi.fn(async () => []),
  getSimilarTrainingExamples: vi.fn(async () => []),
  getCorpusBiasNote: vi.fn(async () => null),
}));
vi.mock('./training', () => ({ getTrainingFewShot: vi.fn(async () => []) }));
vi.mock('./referenceAssets', () => ({ getReferenceAssetsForAnalysis: vi.fn(async () => []) }));

// Minimal example tagged by santasFootage so we can track selection + order.
// `photoCount` (W5-008) fills the `photos` array with that many placeholder
// entries so capFewShotImages has something real to count.
function ex(source: FewShotExample['source'], id: number, photoCount = 0): FewShotExample {
  return {
    photos: Array.from({ length: photoCount }, () => ({ base64: 'x', mediaType: 'image/jpeg' }) as TrainingExamplePhoto),
    santasFootage: id,
    santasDifficulty: 'medium',
    santasLines: [],
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    gingerbreadLines: [],
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    source,
  };
}
const ids = (xs: FewShotExample[]) => xs.map((x) => x.santasFootage);

// Same as ex(), but with `miniCount` synthetic MiniLightDetections so
// biasForMiniLights has real richness to rank on.
function exWithMini(source: FewShotExample['source'], id: number, miniCount: number): FewShotExample {
  const detections: MiniLightDetection[] = Array.from({ length: miniCount }, () => ({
    type: 'bush',
    wrapStyle: 'canopy',
    stringCount: 1,
    box: [0, 0, 0.1, 0.1],
    label: 'bush',
  }));
  return { ...ex(source, id), miniLightDetections: detections };
}

describe('selectFewShot', () => {
  it('FEW_SHOT_LIMIT is 8', () => {
    expect(FEW_SHOT_LIMIT).toBe(8);
  });

  it('under cap: returns all, ordered best-LAST (training → design w/ closest last)', () => {
    const design = [ex('design', 1), ex('design', 2)]; // 1 = closest (best-first input)
    const training = [ex('training', 10)];
    const out = selectFewShot({ design, training }, 8);
    // training first (least weight), then design reversed (closest match #1 sits LAST).
    expect(ids(out)).toEqual([10, 2, 1]);
  });

  it('over cap: design fills first, exactly `limit` returned', () => {
    const design = Array.from({ length: 10 }, (_, i) => ex('design', i)); // 0..9, 0 closest
    const out = selectFewShot({ design, training: [] }, 8);
    expect(out).toHaveLength(8);
    // design.slice(0,8) = 0..7, reversed → 7..0; closest (0) is LAST.
    expect(ids(out)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(out[out.length - 1].santasFootage).toBe(0); // closest match weighted most
  });

  it('priority: design fills before training, capped at `limit`', () => {
    const design = Array.from({ length: 6 }, (_, i) => ex('design', i));
    const training = Array.from({ length: 6 }, (_, i) => ex('training', 10 + i));
    const out = selectFewShot({ design, training }, 8);
    expect(out).toHaveLength(8);
    // 6 design + 2 training (cap reached before all training fits).
    expect(out.filter((x) => x.source === 'design')).toHaveLength(6);
    expect(out.filter((x) => x.source === 'training')).toHaveLength(2);
  });

  it('thin design library: training pads the remaining slots', () => {
    const design = [ex('design', 1)];
    const training = Array.from({ length: 10 }, (_, i) => ex('training', 10 + i));
    const out = selectFewShot({ design, training }, 8);
    expect(out).toHaveLength(8); // 1 design + 7 training
    expect(out.filter((x) => x.source === 'training')).toHaveLength(7);
    expect(out[out.length - 1].santasFootage).toBe(1); // design still last
  });

  it('empty sources → []', () => {
    expect(selectFewShot({ design: [], training: [] }, 8)).toEqual([]);
  });
});

// W5-008 (#110 wave 5, cost): FEW_SHOT_LIMIT caps example COUNT (≤8), but each
// example can carry up to 4 photos — worst case ~32 few-shot images with no
// TOTAL ceiling. capFewShotImages trims whole examples off the LEAST-relevant
// (front) end until the total photo count fits, without ever dropping the
// single most-relevant (last) example.
describe('capFewShotImages', () => {
  it('TOTAL_FEW_SHOT_IMAGE_CAP is a sane positive number below the worst case (32)', () => {
    expect(TOTAL_FEW_SHOT_IMAGE_CAP).toBeGreaterThan(0);
    expect(TOTAL_FEW_SHOT_IMAGE_CAP).toBeLessThan(32);
  });

  it('returns everything unchanged when already under the cap', () => {
    const examples = [ex('training', 1, 4), ex('design', 2, 4)];
    expect(capFewShotImages(examples, 24)).toEqual(examples);
  });

  it('drops least-relevant (front) examples first until under the cap', () => {
    // 4 examples × 4 photos = 16 images; cap at 10 → must drop from the front.
    const examples = [ex('training', 1, 4), ex('training', 2, 4), ex('design', 3, 4), ex('design', 4, 4)];
    const out = capFewShotImages(examples, 10);
    // Front two dropped (1, 2); remaining two (3, 4) = 8 images, under cap.
    expect(ids(out)).toEqual([3, 4]);
  });

  it('never drops the single most-relevant (last) example even if it alone exceeds the cap', () => {
    const examples = [ex('training', 1, 4), ex('design', 2, 4)];
    const out = capFewShotImages(examples, 2); // last example alone (4 photos) already exceeds 2
    expect(ids(out)).toEqual([2]);
  });

  it('empty input → []', () => {
    expect(capFewShotImages([], 24)).toEqual([]);
  });
});

// Retrieval-mini-bias: whole-photo similarity has no way to prefer candidates
// that actually carry mini-light ground truth. biasForMiniLights reserves a
// small slice of the final slots for the richest mini-light examples found
// BEYOND the pure-similarity core, without displacing the majority of
// genuinely-closest-match teaching.
describe('biasForMiniLights', () => {
  it('constants: reserved slots is a small minority of the limit, pool exceeds the limit', () => {
    expect(MINI_RESERVED_SLOTS).toBeGreaterThan(0);
    expect(MINI_RESERVED_SLOTS).toBeLessThan(FEW_SHOT_LIMIT);
    expect(MINI_BIAS_POOL_SIZE).toBeGreaterThan(FEW_SHOT_LIMIT);
  });

  it('candidate pool already ≤ limit: returned unchanged (nothing to bias)', () => {
    const candidates = [exWithMini('design', 0, 0), exWithMini('design', 1, 3)];
    expect(biasForMiniLights(candidates, 8, 2)).toEqual(candidates);
  });

  it('reservedSlots 0: pure similarity order, first `limit` returned untouched', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => exWithMini('design', i, i === 9 ? 5 : 0));
    const out = biasForMiniLights(candidates, 8, 0);
    expect(ids(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // richest candidate (idx 9) never considered
  });

  it('swaps mini-rich candidates from beyond the core into the reserved slots, preserving similarity order', () => {
    // idx 0-5 = core (no mini work); idx 6,7 = empty; idx 8,9 = mini-rich.
    const candidates = [
      exWithMini('design', 0, 0), exWithMini('design', 1, 0), exWithMini('design', 2, 0),
      exWithMini('design', 3, 0), exWithMini('design', 4, 0), exWithMini('design', 5, 0),
      exWithMini('design', 6, 0), exWithMini('design', 7, 0),
      exWithMini('design', 8, 2), exWithMini('design', 9, 4),
    ];
    const out = biasForMiniLights(candidates, 8, 2);
    // Core (0-5) always kept; empty 6,7 dropped in favor of richer 8,9 — order preserved.
    expect(ids(out)).toEqual([0, 1, 2, 3, 4, 5, 8, 9]);
    expect(out.every((e) => candidates.includes(e))).toBe(true);
  });

  it('never drops the pure-similarity core (closest matches always survive)', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => exWithMini('design', i, i >= 10 ? 3 : 0));
    const out = biasForMiniLights(candidates, 8, 2);
    // coreCount = limit(8) - reserved(2) = 6 → idx 0-5 must all be present.
    for (let i = 0; i < 6; i++) expect(ids(out)).toContain(i);
  });

  it('fewer mini-rich candidates than reserved slots: tops up with next-most-similar', () => {
    const candidates = [
      exWithMini('design', 0, 0), exWithMini('design', 1, 0), exWithMini('design', 2, 0),
      exWithMini('design', 3, 0), exWithMini('design', 4, 0), exWithMini('design', 5, 0),
      exWithMini('design', 6, 1), // only ONE rich candidate beyond the core
      exWithMini('design', 7, 0), exWithMini('design', 8, 0),
    ];
    const out = biasForMiniLights(candidates, 8, 2);
    expect(out).toHaveLength(8);
    expect(ids(out)).toContain(6); // the one rich candidate made it in
  });

  it('no mini-rich candidates anywhere beyond the core: falls back to plain top-`limit` similarity', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => exWithMini('design', i, 0));
    const out = biasForMiniLights(candidates, 8, 2);
    expect(ids(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('ties in richness break toward the more-similar (lower-index) candidate', () => {
    const candidates = [
      exWithMini('design', 0, 0), exWithMini('design', 1, 0), exWithMini('design', 2, 0),
      exWithMini('design', 3, 0), exWithMini('design', 4, 0), exWithMini('design', 5, 0),
      exWithMini('design', 6, 2), exWithMini('design', 7, 2), exWithMini('design', 8, 2),
    ];
    const out = biasForMiniLights(candidates, 8, 2);
    // 3 candidates tie at richness 2; the 2 reserved slots go to the 2 most similar (6, 7).
    expect(ids(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('empty input → []', () => {
    expect(biasForMiniLights([], 8, 2)).toEqual([]);
  });
});

// Audit Finding #57: the similarity→recency fallback must no longer be silent
// when similarity was EXPECTED (Voyage configured + a query image present).
describe('assembleFewShot — degraded similarity signal', () => {
  const queryImage = { base64: 'abc', mediaType: 'image/jpeg' };
  let assembleFewShot: typeof import('./fewShot').assembleFewShot;
  let embedImage: ReturnType<typeof vi.fn>;
  let isEmbeddingConfigured: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fewShot = await import('./fewShot');
    assembleFewShot = fewShot.assembleFewShot;
    const embeddings = await import('./embeddings');
    embedImage = embeddings.embedImage as ReturnType<typeof vi.fn>;
    isEmbeddingConfigured = embeddings.isEmbeddingConfigured as ReturnType<typeof vi.fn>;
  });

  it('warns + flags degraded when configured + query image but embed returns null', async () => {
    isEmbeddingConfigured.mockReturnValue(true);
    embedImage.mockResolvedValue(null); // Voyage outage / non-2xx / malformed
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await assembleFewShot(undefined, queryImage);

    expect(warn).toHaveBeenCalledOnce();
    expect(out.breakdown.degraded).toBe(true);
    expect(out.ranking).toBe('recency');
    warn.mockRestore();
  });

  it('no warn / not degraded when no query image (legitimate recency)', async () => {
    isEmbeddingConfigured.mockReturnValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await assembleFewShot(undefined, undefined);

    expect(warn).not.toHaveBeenCalled();
    expect(out.breakdown.degraded).toBe(false);
    warn.mockRestore();
  });

  it('no warn / not degraded when Voyage unconfigured (legitimate recency)', async () => {
    isEmbeddingConfigured.mockReturnValue(false);
    embedImage.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await assembleFewShot(undefined, queryImage);

    expect(warn).not.toHaveBeenCalled();
    expect(out.breakdown.degraded).toBe(false);
    warn.mockRestore();
  });
});

// W5-009 (#110 wave 5, cost): assembleFewShot fetches FEW_SHOT_LIMIT (8) full
// training houses even when the design corpus already fills every slot.
// selectFewShot's own contract (Math.max(0, limit - design.length)) means
// that fetch's result is discarded when design.length >= FEW_SHOT_LIMIT — so
// skip the fetch entirely in that case.
describe('assembleFewShot — skips the redundant training fetch when design fills every slot (W5-009)', () => {
  const queryImage = { base64: 'abc', mediaType: 'image/jpeg' };
  let assembleFewShot: typeof import('./fewShot').assembleFewShot;
  let embedImage: ReturnType<typeof vi.fn>;
  let getSimilarTrainingExamples: ReturnType<typeof vi.fn>;
  let exampleToFewShot: ReturnType<typeof vi.fn>;
  let getTrainingFewShot: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fewShot = await import('./fewShot');
    assembleFewShot = fewShot.assembleFewShot;
    const embeddings = await import('./embeddings');
    embedImage = embeddings.embedImage as ReturnType<typeof vi.fn>;
    const trainingExamples = await import('./trainingExamples');
    getSimilarTrainingExamples = trainingExamples.getSimilarTrainingExamples as ReturnType<typeof vi.fn>;
    exampleToFewShot = trainingExamples.exampleToFewShot as ReturnType<typeof vi.fn>;
    const training = await import('./training');
    getTrainingFewShot = training.getTrainingFewShot as ReturnType<typeof vi.fn>;
  });

  it('skips getTrainingFewShot when the design corpus alone fills FEW_SHOT_LIMIT slots', async () => {
    embedImage.mockResolvedValue([1, 2, 3]); // any non-null vector
    // 8 similar rows, all of which project to real examples — design.length
    // reaches FEW_SHOT_LIMIT (8) with no help from training.
    getSimilarTrainingExamples.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({ id: i })));
    exampleToFewShot.mockImplementation((row: { id: number }) => ex('design', row.id));

    const out = await assembleFewShot(undefined, queryImage);

    expect(getTrainingFewShot).not.toHaveBeenCalled();
    expect(out.breakdown.design).toBe(8);
    expect(out.breakdown.training).toBe(0);
  });

  it('still calls getTrainingFewShot when design does NOT fill every slot', async () => {
    embedImage.mockResolvedValue([1, 2, 3]);
    // Only 3 similar rows — design.length (3) < FEW_SHOT_LIMIT (8).
    getSimilarTrainingExamples.mockResolvedValue(Array.from({ length: 3 }, (_, i) => ({ id: i })));
    exampleToFewShot.mockImplementation((row: { id: number }) => ex('design', row.id));
    getTrainingFewShot.mockResolvedValue([]);

    await assembleFewShot(undefined, queryImage);

    expect(getTrainingFewShot).toHaveBeenCalledTimes(1);
  });
});
