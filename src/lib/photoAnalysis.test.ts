import { describe, it, expect } from 'vitest';
import {
  coerceDifficulty,
  coerceFootage,
  normalizeLines,
  normalizeBoxArray,
  baseSystemPromptFor,
} from './photoAnalysis';
import type { LineSegment } from './photoAnalysis';

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
