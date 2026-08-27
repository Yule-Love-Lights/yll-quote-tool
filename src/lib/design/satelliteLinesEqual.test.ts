// Row 427 — the change detector that lets Jason's ruling and the freeze coexist.
//
// The whole design rests on this being right in BOTH directions. A false
// INEQUALITY refuses a re-Calculate that changed nothing, which is exactly what
// Jason ruled against. A false EQUALITY lets a redraw of the customer's
// approved roofline through, which is what row 367 exists to stop.

import { describe, it, expect } from 'vitest';
import { satelliteLinesEqual } from './satelliteLinesEqual';
import type { DesignSatelliteLines } from '@/lib/designs';

const line = (pts: number[][]) => pts;
const base = { santas: [line([[0.1, 0.1], [0.9, 0.1]])] } as unknown as DesignSatelliteLines;

describe('satelliteLinesEqual — must NOT refuse an unchanged re-Calculate', () => {
  it('is true for the same trace sent back', () => {
    const again = { santas: [line([[0.1, 0.1], [0.9, 0.1]])] } as unknown as DesignSatelliteLines;
    expect(satelliteLinesEqual(base, again)).toBe(true);
  });

  it('is true within the float tolerance a round-trip can introduce', () => {
    const wobbled = { santas: [line([[0.1 + 1e-9, 0.1], [0.9, 0.1 - 1e-9]])] } as unknown as DesignSatelliteLines;
    expect(satelliteLinesEqual(base, wobbled)).toBe(true);
  });

  it('treats a MISSING channel and an EMPTY one as the same nothing', () => {
    // A client that never uses `bistro` omits it; one that touched and cleared
    // it sends []. Neither is an edit, and reading either as one would refuse
    // an ordinary save.
    const withEmpty = { santas: base.santas, bistro: [] } as unknown as DesignSatelliteLines;
    expect(satelliteLinesEqual(base, withEmpty)).toBe(true);
    expect(satelliteLinesEqual(withEmpty, base)).toBe(true);
  });

  it('is true for two empty traces, and for null vs empty', () => {
    expect(satelliteLinesEqual(null, {} as DesignSatelliteLines)).toBe(true);
    expect(satelliteLinesEqual(undefined, null)).toBe(true);
  });
});

describe('satelliteLinesEqual — must REFUSE a real edit', () => {
  it('is false when a point MOVES by more than a hair', () => {
    const moved = { santas: [line([[0.1, 0.1], [0.8, 0.1]])] } as unknown as DesignSatelliteLines;
    expect(satelliteLinesEqual(base, moved)).toBe(false);
  });

  it('is false when a point is ADDED to a line', () => {
    const added = { santas: [line([[0.1, 0.1], [0.5, 0.2], [0.9, 0.1]])] } as unknown as DesignSatelliteLines;
    expect(satelliteLinesEqual(base, added)).toBe(false);
  });

  it('is false when a whole LINE is deleted — the case the staff lens raised', () => {
    const deleted = { santas: [] } as unknown as DesignSatelliteLines;
    expect(satelliteLinesEqual(base, deleted)).toBe(false);
  });

  it('is false when a line is added on ANOTHER channel', () => {
    // The comparison must cover every channel, not just the one that was
    // already populated — otherwise drawing a brand-new ridge line reads as
    // "no change".
    const extra = { santas: base.santas, gingerbread: [line([[0, 0], [1, 1]])] } as unknown as DesignSatelliteLines;
    expect(satelliteLinesEqual(base, extra)).toBe(false);
  });

  it('covers the permanent side channels and bistro too', () => {
    for (const channel of ['front', 'left', 'right', 'back', 'bistro', 'c9', 'stake'] as const) {
      const before = {} as unknown as DesignSatelliteLines;
      const after = { [channel]: [line([[0, 0], [1, 1]])] } as unknown as DesignSatelliteLines;
      expect(satelliteLinesEqual(before, after)).toBe(false);
    }
  });
});
