// Row 427 — the change detector that lets Jason's ruling and the freeze coexist.
//
// The whole design rests on this being right in BOTH directions. A false
// INEQUALITY refuses a re-Calculate that changed nothing, which is exactly what
// Jason ruled against. A false EQUALITY lets a redraw of the customer's
// approved roofline through, which is what row 367 exists to stop.
//
// THESE FIXTURES USE THE REAL SHAPE, and that is the point. The first cut of
// this file used raw `number[][]` polylines; the real channel is an array of
// SEGMENTS, `{ points, label }[]`. Because the fixtures matched the (wrong)
// implementation rather than the type, every test passed while the function was
// blind to any point-level edit. A premerge lens found it by running the real
// shape through the real function. Fixtures now mirror `DesignSatelliteLines`.

import { describe, it, expect } from 'vitest';
import { satelliteLinesEqual } from './satelliteLinesEqual';
import type { DesignSatelliteLines } from '@/lib/designs';

const seg = (points: [number, number][], label = 'Front') => ({ points, label });
const lines = (o: Record<string, unknown>) => o as unknown as DesignSatelliteLines;

const base = lines({ santas: [seg([[0.1, 0.1], [0.9, 0.1]])] });

describe('satelliteLinesEqual — must NOT refuse an unchanged re-Calculate', () => {
  it('is true for the same trace sent back', () => {
    expect(satelliteLinesEqual(base, lines({ santas: [seg([[0.1, 0.1], [0.9, 0.1]])] }))).toBe(true);
  });

  it('is true within the float tolerance a round-trip can introduce', () => {
    expect(
      satelliteLinesEqual(base, lines({ santas: [seg([[0.1 + 1e-9, 0.1], [0.9, 0.1 - 1e-9]])] })),
    ).toBe(true);
  });

  it('treats a MISSING channel and an EMPTY one as the same nothing', () => {
    const withEmpty = lines({ santas: [seg([[0.1, 0.1], [0.9, 0.1]])], bistro: [] });
    expect(satelliteLinesEqual(base, withEmpty)).toBe(true);
    expect(satelliteLinesEqual(withEmpty, base)).toBe(true);
  });

  it('ignores a changed id or feature when the geometry and label match', () => {
    // A rebuild can mint new ids for identical runs. Reading that as an edit
    // would be the false inequality this whole approach exists to avoid.
    const a = lines({ santas: [{ ...seg([[0, 0], [1, 1]]), id: 'a', feature: 'gutter' }] });
    const b = lines({ santas: [{ ...seg([[0, 0], [1, 1]]), id: 'b', feature: 'peak' }] });
    expect(satelliteLinesEqual(a, b)).toBe(true);
  });

  it('is true for two empty traces, and for null vs empty', () => {
    expect(satelliteLinesEqual(null, {} as DesignSatelliteLines)).toBe(true);
    expect(satelliteLinesEqual(undefined, null)).toBe(true);
  });
});

describe('satelliteLinesEqual — must REFUSE a real edit', () => {
  it('is false when a point MOVES — the case the first implementation was blind to', () => {
    expect(satelliteLinesEqual(base, lines({ santas: [seg([[0.1, 0.1], [0.8, 0.1]])] }))).toBe(false);
  });

  it('is false when a point is INSERTED into an existing line, line count unchanged', () => {
    // Same number of lines, so a count-only comparison reports "identical".
    // That was the exact hole.
    expect(
      satelliteLinesEqual(base, lines({ santas: [seg([[0.1, 0.1], [0.5, 0.2], [0.9, 0.1]])] })),
    ).toBe(false);
  });

  it('is false when a point is REMOVED from an existing line', () => {
    const three = lines({ santas: [seg([[0.1, 0.1], [0.5, 0.2], [0.9, 0.1]])] });
    expect(satelliteLinesEqual(three, base)).toBe(false);
  });

  it('is false when a whole LINE is deleted — the case the staff lens raised', () => {
    expect(satelliteLinesEqual(base, lines({ santas: [] }))).toBe(false);
  });

  it('is false when a run is RENAMED — the portal renders the label', () => {
    expect(
      satelliteLinesEqual(base, lines({ santas: [seg([[0.1, 0.1], [0.9, 0.1]], 'Back')] })),
    ).toBe(false);
  });

  it('is false when a line is added on ANOTHER channel', () => {
    const extra = lines({ santas: base.santas, gingerbread: [seg([[0, 0], [1, 1]])] });
    expect(satelliteLinesEqual(base, extra)).toBe(false);
  });

  it('covers the permanent side channels and bistro too', () => {
    for (const channel of ['front', 'left', 'right', 'back', 'bistro', 'c9', 'stake'] as const) {
      expect(satelliteLinesEqual(lines({}), lines({ [channel]: [seg([[0, 0], [1, 1]])] }))).toBe(false);
    }
  });
});
