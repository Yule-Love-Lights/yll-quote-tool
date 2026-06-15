import { describe, it, expect } from 'vitest';
import { summarizeSeedFinalDiff, type SeedFinalFinal } from './seedFinalDiff';
import type { MiniLightDetection, WreathDetection, GarlandDetection } from './photoAnalysis';

// --- tiny factories (only the fields the diff reads actually matter) ---
function mini(stringCount: number): MiniLightDetection {
  return { type: 'bush', wrapStyle: 'canopy', stringCount, box: [0, 0, 0.1, 0.1], label: 'bush' };
}
function wreath(): WreathDetection {
  return { size: '30noble', tier: 'bow', box: [0, 0, 0.1, 0.1], label: 'wreath' };
}
function garland(): GarlandDetection {
  return { length: '9ft', tier: 'bow', box: [0, 0, 0.2, 0.05], label: 'garland' };
}

function final(over: Partial<SeedFinalFinal> = {}): SeedFinalFinal {
  return {
    santasFootage: 40,
    gingerbreadFootage: 60,
    santasDifficulty: 'medium',
    gingerbreadDifficulty: 'medium',
    miniLightDetections: [],
    wreathDetections: [],
    spritzerDetections: [],
    garlandDetections: [],
    ...over,
  };
}

describe('summarizeSeedFinalDiff', () => {
  it('returns null when there is no seed', () => {
    expect(summarizeSeedFinalDiff(null, final())).toBeNull();
    expect(summarizeSeedFinalDiff(undefined, final())).toBeNull();
  });

  it('returns null for a non-object seed (defensive against jsonb junk)', () => {
    expect(summarizeSeedFinalDiff('garbage' as unknown as Record<string, unknown>, final())).toBeNull();
  });

  it('reports footage deltas with the front/ridge labels', () => {
    const note = summarizeSeedFinalDiff(
      { santasFootage: 30, gingerbreadFootage: 45 },
      final({ santasFootage: 55, gingerbreadFootage: 70 }),
    );
    expect(note).toContain('front footage 30→55ft');
    expect(note).toContain('ridge+sides footage 45→70ft');
    expect(note).toContain('corrected by staff');
    expect(note).toContain('JSON below');
  });

  it('reports phantom/missed minis as an item-count delta with strand totals', () => {
    const note = summarizeSeedFinalDiff(
      { miniLightDetections: [mini(3), mini(3), mini(2)] }, // 3 items, 8 strings
      final({ miniLightDetections: [mini(5), mini(6)] }),    // 2 items, 11 strings
    );
    expect(note).toContain('mini-light items 3→2 (strings 8→11)');
  });

  it('reports a pure string-count override (same item count) without an item delta', () => {
    const note = summarizeSeedFinalDiff(
      { miniLightDetections: [mini(2), mini(2)] }, // 2 items, 4 strings
      final({ miniLightDetections: [mini(5), mini(6)] }), // 2 items, 11 strings
    );
    expect(note).toContain('mini-light strings 4→11');
    expect(note).not.toContain('mini-light items');
  });

  it('reports wreath and garland count deltas', () => {
    const note = summarizeSeedFinalDiff(
      { wreathDetections: [wreath()], garlandDetections: [] },
      final({ wreathDetections: [wreath(), wreath()], garlandDetections: [garland()] }),
    );
    expect(note).toContain('wreaths 1→2');
    expect(note).toContain('garland runs 0→1');
  });

  it('reports difficulty changes', () => {
    const note = summarizeSeedFinalDiff(
      { santasDifficulty: 'easy', gingerbreadDifficulty: 'medium' },
      final({ santasDifficulty: 'hard' }),
    );
    expect(note).toContain('front difficulty easy→hard');
    expect(note).not.toContain('ridge+sides difficulty');
  });

  it('only emits a satellite delta when the final teaches satellite footage', () => {
    const withSat = summarizeSeedFinalDiff(
      { satelliteSantasFootage: 50 },
      final({ satelliteSantasFootage: 65 }),
    );
    expect(withSat).toContain('satellite front footage 50→65ft');

    // No satelliteSantasFootage on the final (undefined) → never mentions satellite.
    const noSat = summarizeSeedFinalDiff({ satelliteSantasFootage: 50 }, final());
    expect(noSat).not.toContain('satellite');
  });

  it('treats missing/garbage seed fields as zero/empty without throwing', () => {
    const note = summarizeSeedFinalDiff(
      {}, // empty seed
      final({ santasFootage: 40, gingerbreadFootage: 0, miniLightDetections: [mini(3)] }),
    );
    expect(note).toContain('front footage 0→40ft');
    expect(note).toContain('mini-light items 0→1 (strings 0→3)');
    // gingerbread unchanged (0→0) → not mentioned
    expect(note).not.toContain('ridge+sides footage');
  });

  it('returns the "matched" note when seed equals final', () => {
    const matched = final({ santasFootage: 40, gingerbreadFootage: 60 });
    const note = summarizeSeedFinalDiff(
      {
        santasFootage: 40,
        gingerbreadFootage: 60,
        santasDifficulty: 'medium',
        gingerbreadDifficulty: 'medium',
        miniLightDetections: [],
        wreathDetections: [],
        spritzerDetections: [],
        garlandDetections: [],
      },
      matched,
    );
    expect(note).toContain('already matched the staff-corrected ground truth');
  });
});
