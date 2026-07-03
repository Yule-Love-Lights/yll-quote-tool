import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import {
  coerceDifficulty,
  coerceFootage,
  normalizeLines,
  normalizeBoxArray,
  baseSystemPromptFor,
  extractJson,
  downscaleImageForVision,
  validateMiniLightDetections,
  validateWreathDetections,
  validateSpritzerDetections,
  validateGarlandDetections,
} from './photoAnalysis';
import type { LineSegment, MiniLightDetection, WreathDetection, SpritzerDetection, GarlandDetection } from './photoAnalysis';

// Audit fix (g14-photoanalysis): robustness of the raw-JSON post-processing.

describe('coerceDifficulty', () => {
  it('normalizes an uppercase enum to its valid lowercase form', () => {
    expect(coerceDifficulty('EASY')).toBe('easy');
    expect(coerceDifficulty('Hard')).toBe('hard');
  });
  it('defaults to medium for anything off-enum or missing', () => {
    expect(coerceDifficulty('extreme')).toBe('medium');
    expect(coerceDifficulty(undefined)).toBe('medium');
    expect(coerceDifficulty(3)).toBe('medium');
  });
});

describe('coerceFootage', () => {
  it('coerces a numeric string to a number', () => {
    expect(coerceFootage('40')).toBe(40);
  });
  it('falls back to 0 for non-finite or negative values', () => {
    expect(coerceFootage('not a number')).toBe(0);
    expect(coerceFootage(-5)).toBe(0);
    expect(coerceFootage(NaN)).toBe(0);
    expect(coerceFootage(undefined)).toBe(0);
  });
  it('passes a valid number through', () => {
    expect(coerceFootage(55)).toBe(55);
  });
});

describe('normalizeLines — majority scale, not global max', () => {
  it('keeps real 0-1 lines when one outlier point is out of range', () => {
    // Mostly 0-1 coords with a single 2.3 hallucinated outlier. With the OLD
    // global-max logic this would set scale = 1/1000 and collapse every real
    // line to a sliver. Median-based scale keeps the real lines at full size.
    const lines: LineSegment[] = [
      { label: 'front gutter', points: [[0.1, 0.2], [0.5, 0.2]] },
      { label: 'ridge', points: [[0.1, 0.1], [0.6, 0.1]] },
      { label: 'glitch', points: [[2.3, 0.3], [0.4, 0.3]] },
    ];
    const out = normalizeLines(lines);
    // Real lines survive at full scale (not collapsed near zero).
    const front = out.find(l => l.label === 'front gutter');
    expect(front?.points).toEqual([[0.1, 0.2], [0.5, 0.2]]);
    // The out-of-range point is dropped; the glitch line keeps only its valid point,
    // which leaves <2 points so the whole line is dropped.
    expect(out.find(l => l.label === 'glitch')).toBeUndefined();
  });

  it('rescales a genuine 0-1000 line set down to 0-1', () => {
    const lines: LineSegment[] = [
      { label: 'a', points: [[100, 200], [500, 200]] },
      { label: 'b', points: [[100, 100], [600, 100]] },
    ];
    const out = normalizeLines(lines);
    expect(out[0].points).toEqual([[0.1, 0.2], [0.5, 0.2]]);
  });

  it('returns [] for missing or empty input', () => {
    expect(normalizeLines(undefined)).toEqual([]);
    expect(normalizeLines([])).toEqual([]);
  });
});

// W5-024 (#110 wave 5, test-gap): extractJson previously had zero direct
// coverage (only exercised indirectly via analyzePhoto, which needs a live
// Claude client). Cover its three paths: direct parse, fenced code block, and
// the brace-balance scan (plus its failure modes).
describe('extractJson', () => {
  it('parses a bare JSON object directly', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a ```json ... ``` fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a bare ``` ... ``` fence (no language tag)', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('balance-scans past leading prose to find the outer object', () => {
    expect(extractJson('Here is the JSON: {"a":1} — hope that helps!')).toEqual({ a: 1 });
  });

  it('balance-scans correctly through nested braces and braces inside strings', () => {
    const text = 'prose {"a": {"nested": 1}, "label": "a {weird} string"} trailing';
    expect(extractJson(text)).toEqual({ a: { nested: 1 }, label: 'a {weird} string' });
  });

  it('handles escaped quotes inside strings without breaking the brace scan', () => {
    const text = '{"label": "a \\"quoted\\" word", "n": 1}';
    expect(extractJson(text)).toEqual({ label: 'a "quoted" word', n: 1 });
  });

  it('throws a helpful error when there is no JSON object at all', () => {
    expect(() => extractJson('no json here')).toThrow(/non-JSON response/);
  });

  it('throws a helpful error on malformed JSON inside braces', () => {
    expect(() => extractJson('{"a": ,}')).toThrow(/malformed JSON/);
  });

  it('throws a helpful error on unbalanced braces', () => {
    expect(() => extractJson('{"a": 1')).toThrow(/unbalanced JSON/);
  });
});

describe('normalizeBoxArray — drops out-of-range boxes', () => {
  it('keeps in-range boxes and drops a hallucinated one', () => {
    const dets = [
      { box: [0.1, 0.2, 0.1, 0.1] as [number, number, number, number], label: 'bush' },
      { box: [3.0, 0.2, 0.1, 0.1] as [number, number, number, number], label: 'ghost' },
    ];
    const out = normalizeBoxArray(dets);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('bush');
  });
});

// W5-007 / W5-010 (#110 wave 5, cost): downscale to Claude Vision's effective
// max (~1568px long edge) before sending — lossless for detection, cheaper
// than the original. Never upscales; falls back gracefully on bad input.
describe('downscaleImageForVision', () => {
  async function makeJpeg(width: number, height: number): Promise<string> {
    const buf = await sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 20, b: 20 } },
    }).jpeg().toBuffer();
    return buf.toString('base64');
  }

  it('downscales an image larger than the 1568px ceiling', async () => {
    const big = await makeJpeg(2400, 1200);
    const out = await downscaleImageForVision(big, 'image/jpeg');
    expect(out.mediaType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(1568);
    expect(meta.height).toBeLessThanOrEqual(1568);
    // Genuinely smaller than the input.
    expect(out.base64.length).toBeLessThan(big.length);
  });

  it('leaves a small image unchanged (never upscales)', async () => {
    const small = await makeJpeg(400, 300);
    const out = await downscaleImageForVision(small, 'image/jpeg');
    expect(out.base64).toBe(small);
    const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  it('accepts a full data: URI and strips the prefix from the returned base64', async () => {
    const small = await makeJpeg(200, 200);
    const out = await downscaleImageForVision(`data:image/jpeg;base64,${small}`, 'image/jpeg');
    expect(out.base64).toBe(small);
  });

  it('falls back to the original bytes on undecodable input instead of throwing', async () => {
    const out = await downscaleImageForVision('not-a-real-image', 'image/webp');
    expect(out.base64).toBe('not-a-real-image');
    expect(out.mediaType).toBe('image/webp');
  });
});

// W5-026 (#110 wave 5, bug — the #80-066 remaining half): analyzePhoto passed
// each detection's enum fields (mini type/wrapStyle, wreath size/tier,
// spritzer size, garland length/tier) through verbatim; only the roofline
// scalars/boxes were coerced. These validators drop a detection whose enum
// field is off the known set, and clamp stringCount to a finite ≥1 integer.
describe('detection enum validation (W5-026)', () => {
  it('validateMiniLightDetections drops an off-enum type and clamps stringCount', () => {
    const dets = [
      { type: 'tree', wrapStyle: 'canopy', stringCount: 3, box: [0, 0, 0.1, 0.1], label: 'a' },
      { type: 'unicorn', wrapStyle: 'canopy', stringCount: 3, box: [0, 0, 0.1, 0.1], label: 'b' },
      { type: 'bush', wrapStyle: 'sideways', stringCount: 3, box: [0, 0, 0.1, 0.1], label: 'c' },
      { type: 'column', wrapStyle: 'canopy', stringCount: 1000, box: [0, 0, 0.1, 0.1], label: 'd' },
      { type: 'railing', wrapStyle: 'canopy', stringCount: -5, box: [0, 0, 0.1, 0.1], label: 'e' },
      { type: 'railing', wrapStyle: 'canopy', stringCount: Number.NaN, box: [0, 0, 0.1, 0.1], label: 'f' },
    ] as unknown as MiniLightDetection[];
    const out = validateMiniLightDetections(dets);
    expect(out.map(d => d.label)).toEqual(['a', 'd', 'e', 'f']);
    expect(out.find(d => d.label === 'd')?.stringCount).toBe(50); // clamped to REASONABLE_MAX_STRINGS
    expect(out.find(d => d.label === 'e')?.stringCount).toBe(1); // clamped up to min 1
    expect(out.find(d => d.label === 'f')?.stringCount).toBe(1); // NaN -> 1
  });

  it('validateWreathDetections drops an off-enum size or tier', () => {
    const dets = [
      { size: '30noble', tier: 'bow', box: [0, 0, 0.1, 0.1], label: 'a' },
      { size: '99noble', tier: 'bow', box: [0, 0, 0.1, 0.1], label: 'b' },
      { size: '30noble', tier: 'labor', box: [0, 0, 0.1, 0.1], label: 'c' },
    ] as unknown as WreathDetection[];
    const out = validateWreathDetections(dets);
    expect(out.map(d => d.label)).toEqual(['a']);
  });

  it('validateSpritzerDetections drops an off-enum size', () => {
    const dets = [
      { size: '24', box: [0, 0, 0.1, 0.1], label: 'a' },
      { size: '99', box: [0, 0, 0.1, 0.1], label: 'b' },
    ] as unknown as SpritzerDetection[];
    const out = validateSpritzerDetections(dets);
    expect(out.map(d => d.label)).toEqual(['a']);
  });

  it('validateGarlandDetections drops an off-enum length or tier', () => {
    const dets = [
      { length: '9ft', tier: 'fullDecor', box: [0, 0, 0.1, 0.1], label: 'a' },
      { length: '12ft', tier: 'fullDecor', box: [0, 0, 0.1, 0.1], label: 'b' },
      { length: '9ft', tier: 'labor', box: [0, 0, 0.1, 0.1], label: 'c' },
    ] as unknown as GarlandDetection[];
    const out = validateGarlandDetections(dets);
    expect(out.map(d => d.label)).toEqual(['a']);
  });
});

// #54: the analyzer has two modes — the quoting/design prompt (SUGGEST placements
// on a bare house) and the completed-install prompt (RECORD what is actually lit).
describe('baseSystemPromptFor (#54 analyzer modes)', () => {
  const design = baseSystemPromptFor('design');
  const completed = baseSystemPromptFor('completed');

  it('design mode returns the quoting prompt (suggest-framed)', () => {
    expect(design).toContain('estimate roofline lighting measurements');
    expect(design).toContain('SUGGEST GOOD PLACEMENT SPOTS');
  });

  it('completed mode returns the record-what-is-installed prompt', () => {
    expect(completed).toContain('COMPLETED installation');
    expect(completed).toContain('THIS IS NOT A DESIGN TASK');
    expect(completed).toContain('ACTUALLY LIT');
  });

  it('completed mode drops the "suggest placement" framing', () => {
    expect(completed).not.toContain('SUGGEST GOOD PLACEMENT SPOTS');
    expect(completed).not.toContain('SUGGESTING WHERE to plant');
  });

  it('both modes share the roofline tracing rules + output schema (no drift)', () => {
    // Anchor sentences from ROOFLINE_TRACING_RULES and OUTPUT_JSON_SCHEMA, which
    // both prompts interpolate from the same shared consts.
    for (const p of [design, completed]) {
      expect(p).toContain('THE ONE TEST for every run');
      expect(p).toContain('DOWNSPOUTS / leaders');
      expect(p).toContain('You MUST respond with ONLY valid JSON');
    }
  });

  it('the two modes are distinct prompts', () => {
    expect(design).not.toBe(completed);
  });
});

// W5-011 / W5-012 (#110 wave 5): the LIVE analyzer request shape — prompt
// caching on the static system prefix, the raised max_tokens ceiling + a
// stop_reason warning, and the enum-validated return. Mocks the Claude client
// so these behaviors are covered without a live API call.
describe('analyzePhoto — request shape (W5-011 / W5-012)', () => {
  const okAnalysisJson = JSON.stringify({
    santasFootage: 40,
    santasDifficulty: 'medium',
    santasLines: [],
    gingerbreadFootage: 20,
    gingerbreadDifficulty: 'medium',
    gingerbreadLines: [],
    satelliteSantasLines: [],
    satelliteSantasFootage: 0,
    satelliteGingerbreadLines: [],
    satelliteGingerbreadFootage: 0,
    preferredSource: 'street',
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    garlandDetections: [],
    notes: 'ok',
    confidence: 'high',
  });

  let createMock: ReturnType<typeof vi.fn>;
  let analyzePhoto: typeof import('./photoAnalysis').analyzePhoto;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: okAnalysisJson }],
      stop_reason: 'end_turn',
    });
    vi.doMock('./claude', () => ({
      getClaudeClient: () => ({ messages: { create: createMock } }),
    }));
    const mod = await import('./photoAnalysis');
    analyzePhoto = mod.analyzePhoto;
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.doUnmock('./claude');
    vi.resetModules();
  });

  it('raises max_tokens to 8192 (was 2048)', async () => {
    await analyzePhoto('AAAA', 'image/jpeg');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].max_tokens).toBe(8192);
  });

  it('sends system as an array with the static prompt cache-marked and byte-identical to the single-string prompt', async () => {
    await analyzePhoto('AAAA', 'image/jpeg');
    const { system } = createMock.mock.calls[0][0];
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Content is byte-identical to the base prompt — only wrapped in a block.
    const { baseSystemPromptFor } = await import('./photoAnalysis');
    expect(system[0].text).toBe(baseSystemPromptFor('design'));
    // No trailing empty block when there's no dynamic suffix to add.
    expect(system).toHaveLength(1);
  });

  it('appends an uncached dynamic block when there is per-request context (references present)', async () => {
    await analyzePhoto('AAAA', 'image/jpeg', [], {
      references: [
        { id: 'r1', created_at: '', asset_type: 'wreath', size: '30noble', tier: null, base64: 'BBBB', media_type: 'image/jpeg', caption: null, active: true },
      ],
    });
    const { system } = createMock.mock.calls[0][0];
    expect(system).toHaveLength(2);
    expect(system[1].cache_control).toBeUndefined();
    expect(system[1].text).toContain('product reference image(s)');
  });

  it('logs a warning when stop_reason is max_tokens (does not throw)', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: okAnalysisJson }],
      stop_reason: 'max_tokens',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await analyzePhoto('AAAA', 'image/jpeg');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated at max_tokens'));
    warn.mockRestore();
  });

  it('does not warn when stop_reason is end_turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await analyzePhoto('AAAA', 'image/jpeg');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops a hallucinated off-enum detection from the returned result (W5-026)', async () => {
    createMock.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...JSON.parse(okAnalysisJson),
          miniLightDetections: [
            { type: 'tree', wrapStyle: 'canopy', stringCount: 3, box: [0.1, 0.1, 0.1, 0.1], label: 'real' },
            { type: 'dragon', wrapStyle: 'canopy', stringCount: 3, box: [0.1, 0.1, 0.1, 0.1], label: 'fake' },
          ],
        }),
      }],
      stop_reason: 'end_turn',
    });
    const result = await analyzePhoto('AAAA', 'image/jpeg');
    expect(result.miniLightDetections).toHaveLength(1);
    expect(result.miniLightDetections[0].label).toBe('real');
  });

  it('marks the last reference-block content as cacheable (W5-010) and passes downscaled image bytes through', async () => {
    const jpeg = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const refBase64 = jpeg.toString('base64');
    await analyzePhoto('AAAA', 'image/jpeg', [], {
      references: [
        { id: 'r1', created_at: '', asset_type: 'wreath', size: '30noble', tier: null, base64: refBase64, media_type: 'image/jpeg', caption: null, active: true },
      ],
    });
    const { messages } = createMock.mock.calls[0][0];
    const refTurn = messages[0];
    const imageBlock = refTurn.content.find((b: { type: string }) => b.type === 'image');
    // The sent image is smaller than the original (was downscaled).
    expect(imageBlock.source.data.length).toBeLessThan(refBase64.length);
    // cache_control sits on the LAST block of the reference turn.
    const lastBlock = refTurn.content[refTurn.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
  });
});
