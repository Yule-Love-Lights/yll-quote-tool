import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizePermanentSatelliteResult } from './photoAnalysis';

describe('normalizePermanentSatelliteResult (#140 P2)', () => {
  it('coerces a well-formed model response into the four side channels', () => {
    const r = normalizePermanentSatelliteResult({
      front: [{ points: [[0.1, 0.2], [0.5, 0.2]], label: 'front eave ~42ft' }],
      left: [{ points: [[0.1, 0.2], [0.1, 0.6]], label: 'left eave' }],
      right: [],
      back: [{ points: [[0.1, 0.6], [0.5, 0.6]], label: 'back eave' }],
      notes: 'right side under trees',
      confidence: 'medium',
    });
    expect(r.satelliteLines.front).toHaveLength(1);
    expect(r.satelliteLines.front[0].points).toEqual([[0.1, 0.2], [0.5, 0.2]]);
    expect(r.satelliteLines.right).toEqual([]);
    expect(r.notes).toBe('right side under trees');
    expect(r.confidence).toBe('medium');
  });

  it('degrades garbage safely: missing sides → [], bad confidence → low, notes capped', () => {
    const r = normalizePermanentSatelliteResult({
      front: 'nope',
      confidence: 'certain',
      notes: 'x'.repeat(900),
    });
    expect(r.satelliteLines).toEqual({ front: [], left: [], right: [], back: [] });
    expect(r.confidence).toBe('low');
    expect(r.notes).toHaveLength(500);
    expect(normalizePermanentSatelliteResult(null).satelliteLines.back).toEqual([]);
  });

  it('drops sub-2-point lines and out-of-range hallucinated points (normalizeLines reuse)', () => {
    const r = normalizePermanentSatelliteResult({
      front: [
        { points: [[0.5, 0.5]], label: 'degenerate' },
        { points: [[0.1, 0.1], [0.9, 0.9], [4, -2]], label: 'one bad point' },
      ],
    });
    expect(r.satelliteLines.front).toHaveLength(1);
    expect(r.satelliteLines.front[0].points).toEqual([[0.1, 0.1], [0.9, 0.9]]);
  });

  it('P3: coerces street runs — valid sides only, degenerate runs dropped', () => {
    const r = normalizePermanentSatelliteResult({
      streetRuns: [
        { side: 'front', points: [[0.1, 0.5], [0.4, 0.5], [0.5, 0.3]], label: 'front gutter + rake' },
        { side: 'back', points: [[0.1, 0.1], [0.9, 0.9]], label: 'back never from street' },
        { side: 'left', points: [[0.5, 0.5]], label: 'degenerate' },
        { side: 'right' }, // no points
      ],
    });
    expect(r.streetRuns).toHaveLength(1);
    expect(r.streetRuns[0].side).toBe('front');
    expect(r.streetRuns[0].points).toHaveLength(3);
  });

  it('P3: coerces jumps — positive finite ft only, capped at 200, splitter coerced, and surfaces the dropped over-cap jump', () => {
    const r = normalizePermanentSatelliteResult({
      jumps: [
        { ft: 12, splitter: true, label: 'porch to second story' },
        { ft: 8, splitter: 'yes' }, // truthy-but-not-true → false
        { ft: 0 },
        { ft: -5, splitter: true },
        { ft: 900, splitter: true }, // over MAX_JUMP_FT — dropped, but must be surfaced (WT-36)
        { ft: Number.NaN },
      ],
    });
    expect(r.jumps).toEqual([
      { ft: 12, splitter: true, label: 'porch to second story' },
      { ft: 8, splitter: false, label: '' },
    ]);
    // WT-36: the guard still drops the jump from geometry, but it's no longer
    // silent — a dropped count and a notes warning tell the operator to add
    // that connection's extensions manually (e.g. a real bridge on a large
    // estate that legitimately exceeds the cap).
    expect(r.droppedJumps).toBe(1);
    expect(r.notes).toMatch(/1 jump.*200ft/i);
  });

  it('WT-36: a normal (<=200ft) jump is unaffected — no dropped-jump warning, notes untouched', () => {
    const r = normalizePermanentSatelliteResult({
      jumps: [{ ft: 45, splitter: false, label: 'garage to house' }],
      notes: 'all clear',
    });
    expect(r.jumps).toHaveLength(1);
    expect(r.droppedJumps).toBe(0);
    expect(r.notes).toBe('all clear');
  });

  it('P3: missing streetRuns/jumps default to empty arrays (P2-shaped responses)', () => {
    const r = normalizePermanentSatelliteResult({ front: [], confidence: 'high' });
    expect(r.streetRuns).toEqual([]);
    expect(r.jumps).toEqual([]);
    expect(r.droppedJumps).toBe(0);
  });
});

describe('analyzePermanentSatellite #149 retry-once on unusable JSON', () => {
  const okAnalysisJson = JSON.stringify({
    front: [{ points: [[0.1, 0.2], [0.5, 0.2]], label: 'front eave' }],
    left: [],
    right: [],
    back: [],
    streetRuns: [],
    jumps: [],
    notes: 'ok',
    confidence: 'high',
  });

  let createMock: ReturnType<typeof vi.fn>;
  let analyzePermanentSatellite: typeof import('./photoAnalysis').analyzePermanentSatellite;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: okAnalysisJson }],
      stop_reason: 'end_turn',
    });
    vi.doMock('@/lib/claude', () => ({
      getClaudeClient: () => ({ messages: { create: createMock } }),
    }));
    const mod = await import('./photoAnalysis');
    analyzePermanentSatellite = mod.analyzePermanentSatellite;
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.doUnmock('@/lib/claude');
    vi.resetModules();
  });

  it('retries once on malformed JSON then succeeds, reusing the identical request object', async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"a": ,}' }], stop_reason: 'end_turn' });
    // Second call falls through to the beforeEach default (the good response).
    const result = await analyzePermanentSatellite({ satelliteBase64: 'AAAA', satelliteMediaType: 'image/jpeg' });
    expect(result.satelliteLines.front).toHaveLength(1);
    expect(result.confidence).toBe('high');
    expect(createMock).toHaveBeenCalledTimes(2);
    // Pins the reuse-the-same-request behavior (byte-identical prefix for caching).
    expect(createMock.mock.calls[0][0]).toBe(createMock.mock.calls[1][0]);
  });

  it('bounded: two malformed responses reject, exactly 2 calls (never a 3rd)', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"a": ,}' }], stop_reason: 'end_turn' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"b": ,}' }], stop_reason: 'end_turn' });
    await expect(
      analyzePermanentSatellite({ satelliteBase64: 'AAAA', satelliteMediaType: 'image/jpeg' })
    ).rejects.toThrow(/malformed JSON/);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on an API-call rejection', async () => {
    createMock.mockRejectedValueOnce(new Error('simulated 529'));
    await expect(
      analyzePermanentSatellite({ satelliteBase64: 'AAAA', satelliteMediaType: 'image/jpeg' })
    ).rejects.toThrow('simulated 529');
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
