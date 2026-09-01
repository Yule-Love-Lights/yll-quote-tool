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

  it('keeps per-request context OUT of the system array and in the final user message', async () => {
    // cache-breakpoint fix: the dynamic per-request suffix must not sit between
    // the cached static system prompt and the cached reference-image block, or
    // it changes the reference block's cache-prefix hash on every call. It now
    // rides in the final user message instead.
    await analyzePhoto('AAAA', 'image/jpeg', [], {
      references: [
        { id: 'r1', created_at: '', asset_type: 'wreath', size: '30noble', tier: null, base64: 'BBBB', media_type: 'image/jpeg', caption: null, active: true },
      ],
    });
    const { system, messages } = createMock.mock.calls[0][0];
    // System stays a single cache-marked static block — no dynamic suffix block.
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    // The per-request note rode along in the final user message instead.
    const finalUser = messages[messages.length - 1];
    const finalText = finalUser.content.map((b: { type: string; text?: string }) => b.text ?? '').join('');
    expect(finalText).toContain('product reference image(s)');
  });

  it('keeps the reference-image cache prefix byte-stable across addresses (different feetPerPixel)', async () => {
    // The bug: the dynamic suffix embedded feetPerPixel.toFixed(4), so the prefix
    // leading up to the reference block's cache_control breakpoint differed on
    // every address → the ~6-image library was re-written at 1.25x and almost
    // never read back. After the fix, system + the reference turn(s) must be
    // byte-identical between two different addresses; only the final user
    // message carries the per-request scale.
    await analyzePhoto('AAAA', 'image/jpeg', [], {
      references: [
        { id: 'r1', created_at: '', asset_type: 'wreath', size: '30noble', tier: null, base64: 'BBBB', media_type: 'image/jpeg', caption: null, active: true },
      ],
      satellite: { base64: 'SSSS', mediaType: 'image/jpeg', feetPerPixel: 0.1234 },
    });
    await analyzePhoto('AAAA', 'image/jpeg', [], {
      references: [
        { id: 'r1', created_at: '', asset_type: 'wreath', size: '30noble', tier: null, base64: 'BBBB', media_type: 'image/jpeg', caption: null, active: true },
      ],
      satellite: { base64: 'SSSS', mediaType: 'image/jpeg', feetPerPixel: 0.5678 },
    });
    const callA = createMock.mock.calls[0][0];
    const callB = createMock.mock.calls[1][0];
    // Cached prefix = system + the reference turn (cache_control sits on the last
    // block of messages[0]) + the reference-ack assistant turn. All must be
    // byte-identical so the reference block is a cache HIT on the 2nd call.
    expect(JSON.stringify(callA.system)).toBe(JSON.stringify(callB.system));
    expect(JSON.stringify(callA.messages[0])).toBe(JSON.stringify(callB.messages[0]));
    expect(JSON.stringify(callA.messages[1])).toBe(JSON.stringify(callB.messages[1]));
    // The per-request scale differs — and it lives only in the final user turn.
    const finalTextA = callA.messages[callA.messages.length - 1].content.map((b: { text?: string }) => b.text ?? '').join('');
    const finalTextB = callB.messages[callB.messages.length - 1].content.map((b: { text?: string }) => b.text ?? '').join('');
    expect(finalTextA).toContain('0.1234');
    expect(finalTextB).toContain('0.5678');
    // The scale must NOT leak into the cached reference turn.
    expect(JSON.stringify(callA.messages[0])).not.toContain('0.1234');
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

describe('analyzePhoto #149 retry-once on unusable JSON', () => {
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

  it('retries once on malformed JSON then succeeds', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"a": ,}' }], stop_reason: 'end_turn' });
    // Second call falls through to the beforeEach default (the good response).
    const result = await analyzePhoto('AAAA', 'image/jpeg');
    expect(result.notes).toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on a missing text block then succeeds', async () => {
    createMock.mockResolvedValueOnce({ content: [], stop_reason: 'end_turn' });
    // Second call falls through to the beforeEach default (the good response).
    const result = await analyzePhoto('AAAA', 'image/jpeg');
    expect(result.notes).toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('bounded: two unusable responses throw the second parse error, exactly 2 calls (never a 3rd)', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"a": ,}' }], stop_reason: 'end_turn' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"b": ,}' }], stop_reason: 'end_turn' });
    await expect(analyzePhoto('AAAA', 'image/jpeg')).rejects.toThrow(/malformed JSON/);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on an API-call rejection', async () => {
    createMock.mockRejectedValueOnce(new Error('simulated 529'));
    await expect(analyzePhoto('AAAA', 'image/jpeg')).rejects.toThrow('simulated 529');
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// SHADOW MODE (deterministic-satellite-footage): analyzePhoto() computes
// satellite footage from the model's OWN drawn lines, additively, alongside
// (never replacing) the model's self-reported satelliteSantasFootage /
// satelliteGingerbreadFootage — the exact fields self-serve pricing reads
// (src/lib/selfServe/estimateRange.ts's effectiveRooflineFootage).
describe('analyzePhoto — shadow-mode computed satellite footage (deterministic-satellite-footage)', () => {
  let createMock: ReturnType<typeof vi.fn>;
  let analyzePhoto: typeof import('./photoAnalysis').analyzePhoto;

  const setResponse = (analysisJson: Record<string, unknown>) => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(analysisJson) }],
      stop_reason: 'end_turn',
    });
  };

  const baseAnalysis = {
    santasFootage: 40,
    santasDifficulty: 'medium',
    santasLines: [],
    gingerbreadFootage: 20,
    gingerbreadDifficulty: 'medium',
    gingerbreadLines: [],
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    garlandDetections: [],
    notes: 'ok',
    confidence: 'high',
  };

  beforeEach(async () => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock = vi.fn();
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

  it('computes computedSatelliteSantasFootage/computedSatelliteGingerbreadFootage from the real satellite image dimensions (a real 642x470 PNG, mirroring the live 12 Orient Ave shape) WITHOUT changing the model-stated fields', async () => {
    const satPng = await sharp({
      create: { width: 642, height: 470, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    const satBase64 = satPng.toString('base64');

    // A pure-vertical satellite santas segment: (0.5,0.2)->(0.5,0.8) on 642x470
    // at feetPerPixel=0.3. dy = 0.6*470=282px -> 282*0.3=84.6ft (Math.round=85).
    // The MODEL states a wildly different 40ft — well past the 25% threshold.
    setResponse({
      ...baseAnalysis,
      satelliteSantasLines: [{ points: [[0.5, 0.2], [0.5, 0.8]], label: 'sat front' }],
      satelliteSantasFootage: 40,
      satelliteGingerbreadLines: [],
      satelliteGingerbreadFootage: 0,
      preferredSource: 'satellite',
    });

    const result = await analyzePhoto('AAAA', 'image/jpeg', [], {
      satellite: { base64: satBase64, mediaType: 'image/png', feetPerPixel: 0.3 },
    });

    // The EXISTING fields — the ones self-serve pricing / the seeded scene
    // actually read — are completely unchanged: byte-for-byte the model's own
    // stated numbers, lines, and source pick.
    expect(result.satelliteSantasFootage).toBe(40);
    expect(result.satelliteGingerbreadFootage).toBe(0);
    expect(result.preferredSource).toBe('satellite');
    expect(result.satelliteSantasLines).toEqual([{ points: [[0.5, 0.2], [0.5, 0.8]], label: 'sat front' }]);

    // The NEW shadow fields are additive and correctly derived.
    expect(result.computedSatelliteSantasFootage).toBe(85); // Math.round(84.6)
    expect(result.computedSatelliteGingerbreadFootage).toBe(0); // no lines drawn, but dims+scale known -> a real computable 0, not null
    expect(result.satelliteSantasFootageDisagrees).toBe(true); // |85-40|/40 = 1.125 > 0.25
    expect(result.satelliteGingerbreadFootageDisagrees).toBe(false); // 0 vs 0 (nothing drawn, nothing stated)
  });

  it('leaves computed fields null and disagreement false when no satellite image was supplied', async () => {
    setResponse({
      ...baseAnalysis,
      satelliteSantasLines: [],
      satelliteSantasFootage: 0,
      satelliteGingerbreadLines: [],
      satelliteGingerbreadFootage: 0,
      preferredSource: 'street',
    });

    const result = await analyzePhoto('AAAA', 'image/jpeg'); // no satellite option at all

    expect(result.computedSatelliteSantasFootage).toBeNull();
    expect(result.computedSatelliteGingerbreadFootage).toBeNull();
    expect(result.satelliteSantasFootageDisagrees).toBe(false);
    expect(result.satelliteGingerbreadFootageDisagrees).toBe(false);
  });

  it('leaves computed fields null (never throws) when the satellite base64 is corrupt/undecodable', async () => {
    setResponse({
      ...baseAnalysis,
      satelliteSantasLines: [{ points: [[0, 0], [1, 0]], label: 'sat' }],
      satelliteSantasFootage: 50,
      satelliteGingerbreadLines: [],
      satelliteGingerbreadFootage: 0,
      preferredSource: 'satellite',
    });

    const result = await analyzePhoto('AAAA', 'image/jpeg', [], {
      satellite: { base64: 'not-a-real-png', mediaType: 'image/png', feetPerPixel: 0.3 },
    });

    expect(result.computedSatelliteSantasFootage).toBeNull();
    expect(result.satelliteSantasFootageDisagrees).toBe(false);
    // Stated field is STILL untouched — the decode failure never propagates.
    expect(result.satelliteSantasFootage).toBe(50);
  });

  it('leaves computed fields null when the satellite image has no known feetPerPixel scale (the 642x470/null-scale live training row)', async () => {
    const satPng = await sharp({
      create: { width: 642, height: 470, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    setResponse({
      ...baseAnalysis,
      satelliteSantasLines: [{ points: [[0, 0], [1, 0]], label: 'sat' }],
      satelliteSantasFootage: 50,
      satelliteGingerbreadLines: [],
      satelliteGingerbreadFootage: 0,
      preferredSource: 'satellite',
    });

    const result = await analyzePhoto('AAAA', 'image/jpeg', [], {
      satellite: { base64: satPng.toString('base64'), mediaType: 'image/png' }, // no feetPerPixel
    });

    expect(result.computedSatelliteSantasFootage).toBeNull();
    expect(result.satelliteSantasFootageDisagrees).toBe(false);
  });
});

// SHADOW MODE (door-anchor scale, spike PR #922): a SEPARATE, cheap vision
// call locates the front door / garage door in the STREET photo and derives
// a feet-per-pixel scale — additive, alongside (never replacing) anything
// the main analysis produces. Nothing that reaches pricing/projection/the
// analyzer's own detections reads these three fields today.
describe('analyzePhoto — shadow-mode door-anchor scale (door-anchor-experiment spike, PR #922)', () => {
  let createMock: ReturnType<typeof vi.fn>;
  let analyzePhoto: typeof import('./photoAnalysis').analyzePhoto;
  let photoBase64: string;
  const PHOTO_W = 800;
  const PHOTO_H = 600;

  const okAnalysisJson = {
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
  };
  const mainResponse = { content: [{ type: 'text', text: JSON.stringify(okAnalysisJson) }], stop_reason: 'end_turn' };
  const doorAnchorResponse = (obj: Record<string, unknown>) => ({
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    stop_reason: 'end_turn',
  });
  // Every request the main analyzer sends carries max_tokens: 8192; the
  // door-anchor call carries max_tokens: 300 (see runDoorAnchorShadow) — the
  // one reliable way to tell the two calls apart in a mock, since they share
  // the same model id.
  const isDoorCall = (req: { max_tokens: number }) => req.max_tokens === 300;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const jpeg = await sharp({
      create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer();
    photoBase64 = jpeg.toString('base64');
    createMock = vi.fn();
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
    vi.useRealTimers();
  });

  it('records a front-door anchor scale from a valid model response (image under the downscale threshold, so no rescale needed)', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? doorAnchorResponse({ object: 'front_door', garageDoorWidth: null, bbox: [100, 200, 40, 100], confidence: 0.85 })
        : mainResponse,
    );

    const result = await analyzePhoto(photoBase64, 'image/jpeg');

    expect(result.doorAnchorSource).toBe('front-door');
    expect(result.doorAnchorConfidence).toBe(0.85);
    // 800x600 is under MAX_VISION_EDGE_PX (1568) so sent == original dims, no rescale.
    expect(result.doorAnchorFtPerPx).toBeCloseTo((80 / 12) / 100, 6);
  });

  it('records a garage-door (single) anchor scale', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? doorAnchorResponse({ object: 'garage_door', garageDoorWidth: 'single', bbox: [50, 300, 220, 70], confidence: 0.6 })
        : mainResponse,
    );

    const result = await analyzePhoto(photoBase64, 'image/jpeg');

    expect(result.doorAnchorSource).toBe('garage-door');
    expect(result.doorAnchorFtPerPx).toBeCloseTo((108 / 12) / 220, 6);
  });

  it('rescales ftPerPx into the ORIGINAL photo pixel space when the image was downscaled before the vision call', async () => {
    const bigJpeg = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 5, g: 5, b: 5 } },
    }).jpeg().toBuffer();
    const bigBase64 = bigJpeg.toString('base64');
    const { downscaleImageForVision } = await import('./photoAnalysis');
    const { base64: sentBase64 } = await downscaleImageForVision(bigBase64, 'image/jpeg');
    const sentMeta = await sharp(Buffer.from(sentBase64, 'base64')).metadata();
    const sentW = sentMeta.width!;
    const ORIGINAL_W = 3000;
    expect(sentW).toBeLessThan(ORIGINAL_W); // sanity: this really exercises a downscale

    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? doorAnchorResponse({ object: 'front_door', garageDoorWidth: null, bbox: [10, 10, 20, 60], confidence: 0.7 })
        : mainResponse,
    );

    const result = await analyzePhoto(bigBase64, 'image/jpeg');

    const expectedSentFtPerPx = (80 / 12) / 60;
    const expectedOriginalFtPerPx = expectedSentFtPerPx * (sentW / ORIGINAL_W);
    expect(result.doorAnchorFtPerPx).toBeCloseTo(expectedOriginalFtPerPx, 8);
  });

  it('ambiguous garage width (null) -> all three fields null, no standard size to anchor to', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? doorAnchorResponse({ object: 'garage_door', garageDoorWidth: null, bbox: [50, 300, 220, 70], confidence: 0.6 })
        : mainResponse,
    );
    const result = await analyzePhoto(photoBase64, 'image/jpeg');
    expect(result.doorAnchorFtPerPx).toBeNull();
    expect(result.doorAnchorSource).toBeNull();
    expect(result.doorAnchorConfidence).toBeNull();
  });

  it('"none" (model found no usable anchor) -> all three fields null', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? doorAnchorResponse({ object: 'none', garageDoorWidth: null, bbox: [0, 0, 0, 0], confidence: 0.1 })
        : mainResponse,
    );
    const result = await analyzePhoto(photoBase64, 'image/jpeg');
    expect(result.doorAnchorFtPerPx).toBeNull();
    expect(result.doorAnchorSource).toBeNull();
    expect(result.doorAnchorConfidence).toBeNull();
  });

  it('schema-invalid model response (missing field) -> all three fields null, never throws', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? { content: [{ type: 'text', text: JSON.stringify({ object: 'front_door', bbox: [1, 2, 3, 4] }) }], stop_reason: 'end_turn' } // missing confidence + garageDoorWidth
        : mainResponse,
    );
    const result = await analyzePhoto(photoBase64, 'image/jpeg');
    expect(result.doorAnchorFtPerPx).toBeNull();
  });

  it('malformed JSON from the door-anchor call -> all three fields null, never throws', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? { content: [{ type: 'text', text: '{"object": ,}' }], stop_reason: 'end_turn' }
        : mainResponse,
    );
    const result = await analyzePhoto(photoBase64, 'image/jpeg');
    expect(result.doorAnchorFtPerPx).toBeNull();
  });

  it('an API rejection on the door-anchor call -> all three fields null, never throws, main result unaffected', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req) ? Promise.reject(new Error('simulated door-anchor 529')) : mainResponse,
    );
    const result = await analyzePhoto(photoBase64, 'image/jpeg');
    expect(result.doorAnchorFtPerPx).toBeNull();
    expect(result.notes).toBe('ok'); // the main analysis is completely unaffected
  });

  it('degrades to null and never waits past DOOR_ANCHOR_TIMEOUT_MS when the door-anchor call hangs', async () => {
    vi.useFakeTimers();
    createMock.mockImplementation((req: { max_tokens: number }) =>
      isDoorCall(req) ? new Promise(() => {}) : Promise.resolve(mainResponse), // door call never resolves
    );

    const resultPromise = analyzePhoto(photoBase64, 'image/jpeg');
    await vi.advanceTimersByTimeAsync(8000);
    const result = await resultPromise;

    expect(result.doorAnchorFtPerPx).toBeNull();
    expect(result.doorAnchorSource).toBeNull();
    expect(result.doorAnchorConfidence).toBeNull();
    expect(result.notes).toBe('ok'); // main analysis unaffected by the hang
  });

  // PINNING TEST: every field the rest of the app already reads must be
  // byte-identical whether the door-anchor call succeeds or fails outright —
  // this shadow field can never perturb the real analysis result.
  it('pinning: existing analysis fields are byte-identical whether the door-anchor call succeeds or fails', async () => {
    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req)
        ? doorAnchorResponse({ object: 'front_door', garageDoorWidth: null, bbox: [10, 10, 20, 60], confidence: 0.9 })
        : mainResponse,
    );
    const successResult = await analyzePhoto(photoBase64, 'image/jpeg');

    createMock.mockImplementation(async (req: { max_tokens: number }) =>
      isDoorCall(req) ? Promise.reject(new Error('simulated failure')) : mainResponse,
    );
    const failResult = await analyzePhoto(photoBase64, 'image/jpeg');

    const stripDoorFields = (r: typeof successResult) => {
      const rest: Record<string, unknown> = { ...r };
      delete rest.doorAnchorFtPerPx;
      delete rest.doorAnchorSource;
      delete rest.doorAnchorConfidence;
      return rest;
    };
    expect(stripDoorFields(successResult)).toEqual(stripDoorFields(failResult));
    expect(successResult.doorAnchorSource).toBe('front-door');
    expect(failResult.doorAnchorSource).toBeNull();
  });
});
