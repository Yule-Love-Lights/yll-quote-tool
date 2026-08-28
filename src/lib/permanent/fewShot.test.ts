import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PermanentTrainingExampleRow } from './trainingExamples';
import type { PermanentSatelliteLines } from './photoAnalysis';

// Mocks for assemblePermanentFewShot's dependencies — keep every collaborator
// inert so the embed → similarity → recency-fallback decision (and the
// degraded signal) can be isolated, mirroring src/lib/fewShot.test.ts.
vi.mock('../embeddings', () => ({
  embedImage: vi.fn(),
  isEmbeddingConfigured: vi.fn(),
}));
vi.mock('./trainingExamples', () => ({
  getRecentPermanentTrainingExamples: vi.fn(async () => []),
  getSimilarPermanentTrainingExamples: vi.fn(async () => []),
}));

import {
  rowToPermanentFewShot,
  capPermanentFewShotImages,
  buildPermanentFewShotMessages,
  assemblePermanentFewShot,
  PERMANENT_FEW_SHOT_LIMIT,
  PERMANENT_TOTAL_IMAGE_CAP,
  type PermanentFewShotExample,
} from './fewShot';

const EMPTY_LINES: PermanentSatelliteLines = { front: [], left: [], right: [], back: [] };

function row(overrides: Partial<PermanentTrainingExampleRow> = {}): PermanentTrainingExampleRow {
  return {
    id: 'ex-1',
    created_at: '2026-07-08T00:00:00Z',
    updated_at: '2026-07-08T00:00:00Z',
    quote_id: 'q1',
    design_id: 'd1',
    source: 'manual',
    excluded: false,
    notes: null,
    address: '1 Main',
    street_photo_base64: null,
    street_media_type: null,
    satellite_photo_base64: 'SATBASE64',
    satellite_media_type: 'image/jpeg',
    satellite_feet_per_pixel: 0.15,
    original_analysis: null,
    final_satellite_lines: EMPTY_LINES,
    final_street_runs: null,
    final_inputs: null,
    ...overrides,
  };
}

describe('rowToPermanentFewShot', () => {
  it('returns null when the satellite image is missing (defensive — column is NOT NULL in prod)', () => {
    expect(rowToPermanentFewShot(row({ satellite_photo_base64: '' as unknown as string }))).toBeNull();
    expect(rowToPermanentFewShot(row({ satellite_media_type: null as unknown as string }))).toBeNull();
  });

  it('projects a full row: satellite + street + lines + street runs + jumps from original_analysis', () => {
    const lines: PermanentSatelliteLines = {
      front: [{ points: [[0.1, 0.2], [0.5, 0.2]], label: 'front' }],
      left: [], right: [], back: [],
    };
    const ex = rowToPermanentFewShot(row({
      street_photo_base64: 'STREETBASE64',
      street_media_type: 'image/png',
      final_satellite_lines: lines,
      final_street_runs: [{ side: 'front', points: [[0.1, 0.5], [0.4, 0.5]], label: '' }],
      original_analysis: { jumps: [{ ft: 12, splitter: true, label: 'porch to second story' }] },
      notes: 'missed the back roofline dormer entirely',
    }))!;
    expect(ex).not.toBeNull();
    expect(ex.satelliteBase64).toBe('SATBASE64');
    expect(ex.streetBase64).toBe('STREETBASE64');
    expect(ex.finalSatelliteLines).toEqual(lines);
    expect(ex.finalStreetRuns).toEqual([{ side: 'front', points: [[0.1, 0.5], [0.4, 0.5]], label: '' }]);
    expect(ex.jumps).toEqual([{ ft: 12, splitter: true, label: 'porch to second story' }]);
    expect(ex.notes).toBe('missed the back roofline dormer entirely');
  });

  it('defaults street runs to [] and jumps to [] when original_analysis has none/is malformed', () => {
    expect(rowToPermanentFewShot(row())!.finalStreetRuns).toEqual([]);
    expect(rowToPermanentFewShot(row())!.jumps).toEqual([]);
    expect(rowToPermanentFewShot(row({ original_analysis: { jumps: 'nope' } }))!.jumps).toEqual([]);
  });

  it('passes a null notes row through as null (no note typed)', () => {
    expect(rowToPermanentFewShot(row({ notes: null }))!.notes).toBeNull();
  });
});

function ex(id: number, hasStreet: boolean): PermanentFewShotExample {
  return {
    satelliteBase64: `sat-${id}`,
    satelliteMediaType: 'image/jpeg',
    streetBase64: hasStreet ? `street-${id}` : null,
    streetMediaType: hasStreet ? 'image/jpeg' : null,
    satelliteFeetPerPixel: null,
    finalSatelliteLines: EMPTY_LINES,
    finalStreetRuns: [],
    jumps: [],
    notes: null,
  };
}
const ids = (xs: PermanentFewShotExample[]) => xs.map((x) => Number(x.satelliteBase64.split('-')[1]));

describe('capPermanentFewShotImages', () => {
  it('PERMANENT_TOTAL_IMAGE_CAP is a sane positive number below the worst case (2/example × limit)', () => {
    expect(PERMANENT_TOTAL_IMAGE_CAP).toBeGreaterThan(0);
    expect(PERMANENT_TOTAL_IMAGE_CAP).toBeLessThan(2 * PERMANENT_FEW_SHOT_LIMIT);
  });

  it('returns everything unchanged when already under the cap', () => {
    const examples = [ex(1, true), ex(2, false)]; // 2 + 1 = 3 photos
    expect(capPermanentFewShotImages(examples, 10)).toEqual(examples);
  });

  it('drops least-relevant (front) examples first until under the cap', () => {
    // 4 examples × 2 photos (satellite + street) = 8; cap at 5 → drop from front.
    const examples = [ex(1, true), ex(2, true), ex(3, true), ex(4, true)];
    const out = capPermanentFewShotImages(examples, 5);
    expect(ids(out)).toEqual([3, 4]); // last 2 = 4 photos, under cap
  });

  it('never drops the single most-relevant (last) example even if it alone exceeds the cap', () => {
    const examples = [ex(1, true), ex(2, true)];
    const out = capPermanentFewShotImages(examples, 1); // last example alone (2 photos) already exceeds 1
    expect(ids(out)).toEqual([2]);
  });

  it('empty input → []', () => {
    expect(capPermanentFewShotImages([], 10)).toEqual([]);
  });
});

describe('buildPermanentFewShotMessages — ground-truth JSON exactness', () => {
  it('builds a user turn (satellite only) + an assistant turn matching the analyzer response shape exactly', async () => {
    const lines: PermanentSatelliteLines = {
      front: [{ points: [[0.1, 0.2], [0.5, 0.2]], label: 'front eave' }],
      left: [{ points: [[0.1, 0.2], [0.1, 0.6]], label: 'left eave' }],
      right: [],
      back: [{ points: [[0.1, 0.6], [0.5, 0.6]], label: 'back eave' }],
    };
    const example: PermanentFewShotExample = {
      satelliteBase64: 'sat-bytes',
      satelliteMediaType: 'image/jpeg',
      streetBase64: null,
      streetMediaType: null,
      satelliteFeetPerPixel: 0.1234,
      finalSatelliteLines: lines,
      finalStreetRuns: [{ side: 'front', points: [[0.2, 0.5], [0.6, 0.5]], label: '' }],
      jumps: [{ ft: 12, splitter: true, label: 'porch to second story' }],
      notes: null,
    };

    const messages = await buildPermanentFewShotMessages([example]);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    // text + satellite image + satellite tag text + closing instruction = 4 blocks (no street image).
    const imageBlocks = messages[0].content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(1);
    expect(messages[0].content.some((b) => b.type === 'text' && b.text.includes('0.1234 ft/px'))).toBe(true);

    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toHaveLength(1);
    const assistantBlock = messages[1].content[0];
    if (assistantBlock.type !== 'text') throw new Error('expected a text block');
    const payload = JSON.parse(assistantBlock.text);
    expect(payload).toEqual({
      front: lines.front,
      left: lines.left,
      right: lines.right,
      back: lines.back,
      streetRuns: example.finalStreetRuns,
      jumps: example.jumps,
      notes: '',
      confidence: 'high',
    });
  });

  it('includes a second image + tag when a street photo is present', async () => {
    const example: PermanentFewShotExample = {
      satelliteBase64: 'sat-bytes',
      satelliteMediaType: 'image/jpeg',
      streetBase64: 'street-bytes',
      streetMediaType: 'image/jpeg',
      satelliteFeetPerPixel: null,
      finalSatelliteLines: EMPTY_LINES,
      finalStreetRuns: [],
      jumps: [],
      notes: null,
    };
    const messages = await buildPermanentFewShotMessages([example]);
    const imageBlocks = messages[0].content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(2);
    expect(messages[0].content.some((b) => b.type === 'text' && b.text.includes('street view'))).toBe(true);
  });

  it('empty input → []', async () => {
    expect(await buildPermanentFewShotMessages([])).toEqual([]);
  });

  it('injects "Known AI pitfall on this house: <note>" into the assistant notes field when a staff note is present', async () => {
    const example: PermanentFewShotExample = {
      satelliteBase64: 'sat-bytes',
      satelliteMediaType: 'image/jpeg',
      streetBase64: null,
      streetMediaType: null,
      satelliteFeetPerPixel: null,
      finalSatelliteLines: EMPTY_LINES,
      finalStreetRuns: [],
      jumps: [],
      notes: 'missed the back roofline dormer entirely',
    };
    const messages = await buildPermanentFewShotMessages([example]);
    const assistantBlock = messages[1].content[0];
    if (assistantBlock.type !== 'text') throw new Error('expected a text block');
    const payload = JSON.parse(assistantBlock.text);
    expect(payload.notes).toBe('Known AI pitfall on this house: missed the back roofline dormer entirely');
  });

  it('a null note produces an empty notes field, no "Known AI pitfall" line', async () => {
    const example: PermanentFewShotExample = {
      satelliteBase64: 'sat-bytes',
      satelliteMediaType: 'image/jpeg',
      streetBase64: null,
      streetMediaType: null,
      satelliteFeetPerPixel: null,
      finalSatelliteLines: EMPTY_LINES,
      finalStreetRuns: [],
      jumps: [],
      notes: null,
    };
    const messages = await buildPermanentFewShotMessages([example]);
    const assistantBlock = messages[1].content[0];
    if (assistantBlock.type !== 'text') throw new Error('expected a text block');
    expect(assistantBlock.text).not.toContain('Known AI pitfall');
    const payload = JSON.parse(assistantBlock.text);
    expect(payload.notes).toBe('');
  });
});

// Mirrors src/lib/fewShot.test.ts's degraded-similarity coverage.
describe('assemblePermanentFewShot — similarity → recency fallback + degraded signal', () => {
  let embedImage: ReturnType<typeof vi.fn>;
  let isEmbeddingConfigured: ReturnType<typeof vi.fn>;
  let getSimilarPermanentTrainingExamples: ReturnType<typeof vi.fn>;
  let getRecentPermanentTrainingExamples: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const embeddings = await import('../embeddings');
    embedImage = embeddings.embedImage as ReturnType<typeof vi.fn>;
    isEmbeddingConfigured = embeddings.isEmbeddingConfigured as ReturnType<typeof vi.fn>;
    const trainingExamples = await import('./trainingExamples');
    getSimilarPermanentTrainingExamples = trainingExamples.getSimilarPermanentTrainingExamples as ReturnType<typeof vi.fn>;
    getRecentPermanentTrainingExamples = trainingExamples.getRecentPermanentTrainingExamples as ReturnType<typeof vi.fn>;
  });

  it('warns + flags degraded when configured but embed returns null (Voyage outage)', async () => {
    isEmbeddingConfigured.mockReturnValue(true);
    embedImage.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await assemblePermanentFewShot('sat', 'image/jpeg');

    expect(warn).toHaveBeenCalledOnce();
    expect(out.breakdown.degraded).toBe(true);
    expect(out.ranking).toBe('recency');
    warn.mockRestore();
  });

  it('not degraded when Voyage is unconfigured (legitimate recency)', async () => {
    isEmbeddingConfigured.mockReturnValue(false);
    embedImage.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await assemblePermanentFewShot('sat', 'image/jpeg');

    expect(warn).not.toHaveBeenCalled();
    expect(out.breakdown.degraded).toBe(false);
    warn.mockRestore();
  });

  it('uses similarity + reverses to best-last when the embed + retrieval succeed', async () => {
    isEmbeddingConfigured.mockReturnValue(true);
    embedImage.mockResolvedValue([1, 2, 3]);
    getSimilarPermanentTrainingExamples.mockResolvedValue([
      row({ id: 'a', satellite_photo_base64: 'closest' }),
      row({ id: 'b', satellite_photo_base64: 'second' }),
    ]);

    const out = await assemblePermanentFewShot('sat', 'image/jpeg');

    expect(out.ranking).toBe('similarity');
    expect(getRecentPermanentTrainingExamples).not.toHaveBeenCalled();
    // closest-first input reversed → closest sits LAST (most weight).
    expect(out.examples.map((e) => e.satelliteBase64)).toEqual(['second', 'closest']);
  });

  it('degrades to zero-shot (never throws) when a dependency rejects', async () => {
    isEmbeddingConfigured.mockReturnValue(true);
    embedImage.mockRejectedValue(new Error('network down'));

    const out = await assemblePermanentFewShot('sat', 'image/jpeg');

    expect(out).toEqual({ examples: [], ranking: 'recency', breakdown: { count: 0, ranking: 'recency', degraded: false } });
  });
});
