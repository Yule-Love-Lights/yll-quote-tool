import { describe, it, expect } from 'vitest';
import { deriveSideMeasure } from './satelliteMeasure';
import { roundFootageUpTo5 } from './types';

describe('roundFootageUpTo5 (#139)', () => {
  it('rounds up to the next multiple of 5; exact multiples stay', () => {
    expect(roundFootageUpTo5(37)).toBe(40);
    expect(roundFootageUpTo5(22)).toBe(25);
    expect(roundFootageUpTo5(41)).toBe(45);
    expect(roundFootageUpTo5(35)).toBe(35);
    expect(roundFootageUpTo5(51.2)).toBe(55); // raw satellite floats round up too
    expect(roundFootageUpTo5(0.4)).toBe(5); // any drawn run bills at least 5 ft
  });
  it('0 / negative / NaN clamp to 0 (no line billed)', () => {
    expect(roundFootageUpTo5(0)).toBe(0);
    expect(roundFootageUpTo5(-20)).toBe(0);
    expect(roundFootageUpTo5(Number.NaN)).toBe(0);
  });
});

describe('deriveSideMeasure (#88 permanent satellite measurement)', () => {
  it('footage = aspect-corrected length × 640px × feet-per-pixel, rounded UP to a 5-ft step (#139)', () => {
    // Horizontal run 0.1→0.9 on a square image (aspect 1) = 0.8 normalized.
    // 0.8 × 640px = 512px; at 0.1 ft/px → 51.2 → 55 ft. corners = 2 endpoints.
    const m = deriveSideMeasure([{ points: [[0.1, 0.5], [0.9, 0.5]] }], 0.1, 1);
    expect(m.footage).toBe(55);
    expect(m.corners).toBe(2);
  });

  it('counts every vertex as a corner (a run traced start→corner→end = 3)', () => {
    const m = deriveSideMeasure([{ points: [[0.1, 0.5], [0.5, 0.3], [0.9, 0.5]] }], 0.1, 1);
    expect(m.corners).toBe(3);
  });

  it('sums footage + corners across multiple runs on the side', () => {
    const m = deriveSideMeasure(
      [
        { points: [[0.1, 0.5], [0.9, 0.5]] }, // 0.8
        { points: [[0.2, 0.2], [0.2, 0.7]] }, // 0.5
      ],
      0.1,
      1,
    );
    // (0.8 + 0.5) × 640 × 0.1 = 83.2 → 85 (5-ft step); corners = 2 + 2 = 4
    expect(m.footage).toBe(85);
    expect(m.corners).toBe(4);
  });

  it('corners derive with NO scale; footage is null (manual satellite upload)', () => {
    const m = deriveSideMeasure([{ points: [[0.1, 0.5], [0.5, 0.3], [0.9, 0.5]] }], null, 1);
    expect(m.footage).toBeNull();
    expect(m.corners).toBe(3);
  });

  it('a zero/negative feet-per-pixel yields null footage (no bad scale billed)', () => {
    expect(deriveSideMeasure([{ points: [[0, 0], [1, 0]] }], 0, 1).footage).toBeNull();
  });

  it('applies the aspect correction to the vertical axis', () => {
    // Vertical run 0.2→0.7 (Δy 0.5) on a 2:1 (wide) image → yScale 1/2 → 0.25.
    // 0.25 × 640 × 0.1 = 16 ft → 20 (5-ft step).
    const m = deriveSideMeasure([{ points: [[0.3, 0.2], [0.3, 0.7]] }], 0.1, 2);
    expect(m.footage).toBe(20);
  });

  it('a degenerate run (<2 points) contributes nothing', () => {
    const m = deriveSideMeasure([{ points: [[0.5, 0.5]] }], 0.1, 1);
    expect(m.footage).toBe(0);
    expect(m.corners).toBe(0);
  });

  it('no lines → 0 footage (with scale), 0 corners', () => {
    expect(deriveSideMeasure([], 0.1, 1)).toEqual({ footage: 0, corners: 0 });
  });
});
