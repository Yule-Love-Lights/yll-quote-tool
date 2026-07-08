import { describe, it, expect } from 'vitest';
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

  it('P3: coerces jumps — positive finite ft only, capped at 200, splitter coerced', () => {
    const r = normalizePermanentSatelliteResult({
      jumps: [
        { ft: 12, splitter: true, label: 'porch to second story' },
        { ft: 8, splitter: 'yes' }, // truthy-but-not-true → false
        { ft: 0 },
        { ft: -5, splitter: true },
        { ft: 900, splitter: true }, // hallucinated distance
        { ft: Number.NaN },
      ],
    });
    expect(r.jumps).toEqual([
      { ft: 12, splitter: true, label: 'porch to second story' },
      { ft: 8, splitter: false, label: '' },
    ]);
  });

  it('P3: missing streetRuns/jumps default to empty arrays (P2-shaped responses)', () => {
    const r = normalizePermanentSatelliteResult({ front: [], confidence: 'high' });
    expect(r.streetRuns).toEqual([]);
    expect(r.jumps).toEqual([]);
  });
});
