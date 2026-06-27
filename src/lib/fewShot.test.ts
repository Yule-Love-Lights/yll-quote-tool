import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectFewShot, FEW_SHOT_LIMIT } from './fewShot';
import type { FewShotExample } from './photoAnalysis';

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
function ex(source: FewShotExample['source'], id: number): FewShotExample {
  return {
    photos: [],
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
