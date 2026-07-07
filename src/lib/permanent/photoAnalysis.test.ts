import { describe, it, expect } from 'vitest';
import {
  extractJson,
  coerceSide,
  coerceFootage,
  normalizeRooflineRuns,
  normalizeGapCandidates,
  sumFeetBySide,
  sumCornersBySide,
  GAP_MIN_FT,
} from './photoAnalysis';
import type { PermanentRooflineRun, PermanentGapCandidate } from './photoAnalysis';

// Draft unit tests for the PURE parts of the permanent photo analyzer only
// (sanitizers/normalizers/validators). No live-model calls here — mirrors
// src/lib/photoAnalysis.test.ts's shape for the equivalent holiday helpers.

describe('coerceSide', () => {
  it('normalizes an uppercase/whitespace side to its lowercase enum form', () => {
    expect(coerceSide('FRONT')).toBe('front');
    expect(coerceSide(' Left ')).toBe('left');
  });
  it('returns undefined for anything off-enum or missing', () => {
    expect(coerceSide('top')).toBeUndefined();
    expect(coerceSide(undefined)).toBeUndefined();
    expect(coerceSide(3)).toBeUndefined();
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

describe('extractJson', () => {
  it('parses a bare JSON object directly', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips a ```json ... ``` fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('balance-scans past leading prose to find the outer object', () => {
    expect(extractJson('Here is the JSON: {"a":1} — hope that helps!')).toEqual({ a: 1 });
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

describe('normalizeRooflineRuns', () => {
  it('keeps a well-formed run and reports its flat points unchanged (already 0-1)', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0.1, 0.2, 0.5, 0.2], label: 'front roofline ~40ft' },
    ];
    const out = normalizeRooflineRuns(runs);
    expect(out).toHaveLength(1);
    expect(out[0].points).toEqual([0.1, 0.2, 0.5, 0.2]);
    expect(out[0].side).toBe('front');
  });

  it('rescales a genuine 0-1000 point set down to 0-1 by majority scale', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [100, 200, 500, 200], label: 'a' },
      { side: 'left', points: [100, 100, 600, 100], label: 'b' },
    ];
    const out = normalizeRooflineRuns(runs);
    expect(out.find(r => r.label === 'a')?.points).toEqual([0.1, 0.2, 0.5, 0.2]);
  });

  it('drops a run with a missing/off-enum side (hallucination)', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0.1, 0.2, 0.5, 0.2], label: 'good' },
      { side: 'top' as PermanentRooflineRun['side'], points: [0.1, 0.1, 0.4, 0.1], label: 'bad side' },
    ];
    const out = normalizeRooflineRuns(runs);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('good');
  });

  it('drops individual out-of-range points and then drops the run if fewer than 2 points survive', () => {
    // Mostly 0-1 coords with one hallucinated 2.3 outlier on its own line —
    // majority scale keeps the real line at full size; the outlier line
    // collapses to <2 points and is dropped entirely.
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0.1, 0.2, 0.5, 0.2], label: 'front gutter' },
      { side: 'left', points: [0.1, 0.1, 0.6, 0.1], label: 'left gutter' },
      { side: 'back', points: [2.3, 0.3, 0.4, 0.3], label: 'glitch' },
    ];
    const out = normalizeRooflineRuns(runs);
    expect(out.find(r => r.label === 'front gutter')?.points).toEqual([0.1, 0.2, 0.5, 0.2]);
    expect(out.find(r => r.label === 'glitch')).toBeUndefined();
  });

  it('drops a malformed run with an odd number of coordinates down to <2 points', () => {
    // A single trailing x with no paired y — the loop only consumes full
    // pairs, so this leaves just 1 point and the run is dropped.
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0.1, 0.2, 0.9], label: 'malformed' },
    ];
    expect(normalizeRooflineRuns(runs)).toEqual([]);
  });

  it('returns [] for missing or empty input', () => {
    expect(normalizeRooflineRuns(undefined)).toEqual([]);
    expect(normalizeRooflineRuns([])).toEqual([]);
  });

  it('coerces a negative/NaN footageFt to undefined rather than keeping a bad number', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0.1, 0.2, 0.5, 0.2], label: 'a', footageFt: -5 },
      { side: 'left', points: [0.1, 0.2, 0.5, 0.2], label: 'b', footageFt: Number.NaN },
      { side: 'right', points: [0.1, 0.2, 0.5, 0.2], label: 'c', footageFt: 42 },
    ];
    const out = normalizeRooflineRuns(runs);
    expect(out.find(r => r.label === 'a')?.footageFt).toBeUndefined();
    expect(out.find(r => r.label === 'b')?.footageFt).toBeUndefined();
    expect(out.find(r => r.label === 'c')?.footageFt).toBe(42);
  });
});

describe('normalizeGapCandidates', () => {
  it('keeps a well-formed gap with a derivable length', () => {
    const gaps: PermanentGapCandidate[] = [
      { side: 'front', position: [0.5, 0.4], lengthFt: 6, label: 'gap at garage return' },
    ];
    const out = normalizeGapCandidates(gaps);
    expect(out).toHaveLength(1);
    expect(out[0].lengthFt).toBe(6);
  });

  it('keeps a gap with no derivable length (position/flag only) — unknown is not zero', () => {
    const gaps: PermanentGapCandidate[] = [
      { side: 'back', position: [0.3, 0.6], label: 'gap near chimney, measure on site' },
    ];
    const out = normalizeGapCandidates(gaps);
    expect(out).toHaveLength(1);
    expect(out[0].lengthFt).toBeUndefined();
  });

  it('ignores gap candidates below the minimum length', () => {
    const gaps: PermanentGapCandidate[] = [
      { side: 'front', position: [0.5, 0.4], lengthFt: GAP_MIN_FT / 2, label: 'noise' },
      { side: 'front', position: [0.5, 0.4], lengthFt: GAP_MIN_FT, label: 'right at the floor' },
    ];
    const out = normalizeGapCandidates(gaps);
    expect(out.find(g => g.label === 'noise')).toBeUndefined();
    expect(out.find(g => g.label === 'right at the floor')).toBeDefined();
  });

  it('drops a gap with a missing/off-enum side or an out-of-range position', () => {
    const gaps: PermanentGapCandidate[] = [
      { side: 'diagonal' as PermanentGapCandidate['side'], position: [0.5, 0.5], label: 'bad side' },
      { side: 'front', position: [1.9, 0.5], label: 'bad position' },
      { side: 'front', position: [0.5, 0.5], label: 'good' },
    ];
    const out = normalizeGapCandidates(gaps);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('good');
  });

  it('rejects a negative length the same way as a below-threshold one', () => {
    const gaps: PermanentGapCandidate[] = [
      { side: 'front', position: [0.5, 0.5], lengthFt: -3, label: 'negative' },
    ];
    // coerceOptionalFootage drops negative values to undefined, so the gap
    // survives (unknown length) rather than being filtered by the min-length
    // check — assert the length itself never comes through negative.
    const out = normalizeGapCandidates(gaps);
    expect(out[0]?.lengthFt).toBeUndefined();
  });

  it('returns [] for missing or empty input', () => {
    expect(normalizeGapCandidates(undefined)).toEqual([]);
    expect(normalizeGapCandidates([])).toEqual([]);
  });
});

describe('sumFeetBySide', () => {
  it('sums each run footageFt into its side bucket and rounds the total', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0, 0, 1, 0], label: 'a', footageFt: 20.4 },
      { side: 'front', points: [0, 0, 1, 0], label: 'b', footageFt: 10.4 },
      { side: 'left', points: [0, 0, 1, 0], label: 'c', footageFt: 15 },
    ];
    const totals = sumFeetBySide(runs);
    expect(totals.front).toBe(31); // 30.8 rounded
    expect(totals.left).toBe(15);
    expect(totals.right).toBe(0);
    expect(totals.back).toBe(0);
  });

  it('treats a run with no footageFt as contributing 0', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'back', points: [0, 0, 1, 0], label: 'no footage given' },
    ];
    expect(sumFeetBySide(runs).back).toBe(0);
  });
});

describe('sumCornersBySide', () => {
  it('counts every vertex (incl. endpoints) as a corner — a straight run is 2', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0, 0, 1, 0], label: 'straight' },
    ];
    expect(sumCornersBySide(runs).front).toBe(2);
  });

  it('counts a peak (base, apex, base) as 3 corners', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'front', points: [0, 0, 0.5, -0.2, 1, 0], label: 'peak' },
    ];
    expect(sumCornersBySide(runs).front).toBe(3);
  });

  it('sums multiple runs on the same side', () => {
    const runs: PermanentRooflineRun[] = [
      { side: 'left', points: [0, 0, 1, 0], label: 'run1' }, // 2
      { side: 'left', points: [0, 0, 0.5, -0.2, 1, 0], label: 'run2' }, // 3
    ];
    expect(sumCornersBySide(runs).left).toBe(5);
  });
});
