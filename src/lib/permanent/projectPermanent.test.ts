import { describe, it, expect } from 'vitest';
import { projectPermanentDesign, applyPermanentProjection } from './projectPermanent';
import { makeDefaultPermanentFields } from './types';
import type { PermanentDesignProjection } from './projectPermanent';
import type { Scene, StrandItem, SideOfHouse, Yardstick } from '@/lib/design/sceneTypes';

// A yardstick where px == ft (100 px measured == 100 real ft → pxPerFoot = 1),
// so test geometry reads directly in feet.
const YS: Yardstick = { id: 'y1', realFeet: 100, x: 0, y: 0, width: 100, height: 100, axis: 'width' };

function strand(
  id: string,
  points: number[],
  sideOfHouse: SideOfHouse | null,
  bulbType: StrandItem['bulbType'] = 'permanent',
): StrandItem {
  return {
    kind: 'strand',
    id,
    yardstickId: 'y1',
    bulbType,
    spacingIn: 8,
    drawingStyle: 'straight',
    colorPattern: ['warm-white'],
    points,
    sideOfHouse,
  } as unknown as StrandItem;
}

function scene(items: StrandItem[]): Scene {
  return { yardsticks: [YS], items };
}

describe('projectPermanentDesign', () => {
  it('sums footage per side from the drawn permanent strands (px == ft here)', () => {
    // Front 100 ft straight; left 40 ft straight.
    const s = scene([
      strand('a', [0, 0, 100, 0], 'front'),
      strand('b', [0, 0, 40, 0], 'left'),
    ]);
    const p = projectPermanentDesign(s);
    expect(p.feetBySide.front).toBe(100);
    expect(p.feetBySide.left).toBe(40);
    expect(p.feetBySide.right).toBe(0);
    expect(p.feetBySide.back).toBe(0);
  });

  it('counts every polyline vertex (incl. endpoints) as a corner — a peak is 3', () => {
    const straight = scene([strand('a', [0, 0, 100, 0], 'front')]); // 2 vertices
    expect(projectPermanentDesign(straight).cornersBySide.front).toBe(2);

    const peak = scene([strand('a', [0, 0, 50, -20, 100, 0], 'front')]); // 3 vertices (base, apex, base)
    expect(projectPermanentDesign(peak).cornersBySide.front).toBe(3);
  });

  it('groups an untagged strand into the `unassigned` bucket, never dropped', () => {
    const p = projectPermanentDesign(scene([strand('a', [0, 0, 60, 0], null)]));
    expect(p.feetBySide.unassigned).toBe(60);
    expect(p.cornersBySide.unassigned).toBe(2);
    expect(p.feetBySide.front).toBe(0);
  });

  it('ignores non-permanent strands (a c9 roofline is not a permanent run)', () => {
    const p = projectPermanentDesign(scene([strand('a', [0, 0, 100, 0], 'front', 'c9')]));
    expect(p.feetBySide.front).toBe(0);
    expect(p.frontGapCandidates).toEqual([]);
  });

  it('auto-detects a FRONT gap between consecutive strands (end of A → start of B)', () => {
    // A ends at (50,0); B starts at (54,0) → 4 ft break.
    const s = scene([
      strand('a', [0, 0, 50, 0], 'front'),
      strand('b', [54, 0, 100, 0], 'front'),
    ]);
    const p = projectPermanentDesign(s);
    expect(p.frontGapCandidates).toEqual([{ lengthFt: 4, fromStrandId: 'a', toStrandId: 'b' }]);
  });

  it('ignores a sub-threshold (touching) gap and a single front strand', () => {
    const touching = scene([
      strand('a', [0, 0, 50, 0], 'front'),
      strand('b', [50.2, 0, 100, 0], 'front'), // 0.2 ft < 0.5 → not a gap
    ]);
    expect(projectPermanentDesign(touching).frontGapCandidates).toEqual([]);

    const single = scene([strand('a', [0, 0, 100, 0], 'front')]);
    expect(projectPermanentDesign(single).frontGapCandidates).toEqual([]);
  });

  it('returns zeroed buckets + no candidates for an empty scene', () => {
    const p = projectPermanentDesign({ yardsticks: [], items: [] });
    expect(p.feetBySide).toEqual({ front: 0, left: 0, right: 0, back: 0, unassigned: 0 });
    expect(p.cornersBySide).toEqual({ front: 0, left: 0, right: 0, back: 0, unassigned: 0 });
    expect(p.frontGapCandidates).toEqual([]);
  });
});

describe('applyPermanentProjection', () => {
  function proj(overrides: Partial<PermanentDesignProjection> = {}): PermanentDesignProjection {
    return {
      feetBySide: { front: 0, left: 0, right: 0, back: 0, unassigned: 0 },
      cornersBySide: { front: 0, left: 0, right: 0, back: 0, unassigned: 0 },
      frontGapCandidates: [],
      ...overrides,
    };
  }

  it('drives ALL FOUR sides (footage + corners) from the design when covered', () => {
    const out = applyPermanentProjection(
      makeDefaultPermanentFields(),
      proj({
        feetBySide: { front: 100, left: 40, right: 30, back: 20, unassigned: 0 },
        cornersBySide: { front: 5, left: 3, right: 3, back: 2, unassigned: 0 },
      }),
    );
    expect([out.frontFootage, out.leftFootage, out.rightFootage, out.backFootage]).toEqual([100, 40, 30, 20]);
    expect([out.frontCorners, out.leftCorners, out.rightCorners, out.backCorners]).toEqual([5, 3, 3, 2]);
  });

  it('keeps a manual side the design does NOT cover (never wipes satellite-measured footage)', () => {
    const fields = { ...makeDefaultPermanentFields(), backFootage: 55, backCorners: 6 };
    const out = applyPermanentProjection(
      fields,
      proj({
        feetBySide: { front: 100, left: 0, right: 0, back: 0, unassigned: 0 },
        cornersBySide: { front: 2, left: 0, right: 0, back: 0, unassigned: 0 },
      }),
    );
    expect(out.frontFootage).toBe(100); // design covers front → applied
    expect(out.backFootage).toBe(55); // design has no back → manual preserved
    expect(out.backCorners).toBe(6);
  });

  it('regenerates auto front-gap rows and keeps only operator manual gaps', () => {
    const fields = {
      ...makeDefaultPermanentFields(),
      gaps: [
        { lengthFt: 9, source: 'manual' as const },
        { lengthFt: 4, detectedFt: 4, source: 'auto' as const },
        { lengthFt: 7, detectedFt: 5, source: 'edited' as const },
      ],
    };
    const out = applyPermanentProjection(
      fields,
      proj({
        feetBySide: { front: 50, left: 0, right: 0, back: 0, unassigned: 0 },
        frontGapCandidates: [{ lengthFt: 6, fromStrandId: 'a', toStrandId: 'b' }],
      }),
    );
    expect(out.gaps).toEqual([
      { lengthFt: 6, detectedFt: 6, source: 'auto' },
      { lengthFt: 9, source: 'manual' },
    ]);
  });

  it('clears a side once its design run is removed — no stale over-bill', () => {
    // 1st refresh: design covers the back → filled + tagged 'auto'.
    const filled = applyPermanentProjection(
      makeDefaultPermanentFields(),
      proj({
        feetBySide: { front: 0, left: 0, right: 0, back: 55, unassigned: 0 },
        cornersBySide: { front: 0, left: 0, right: 0, back: 6, unassigned: 0 },
      }),
    );
    expect(filled.backFootage).toBe(55);
    expect(filled.sideSource?.back).toBe('auto');
    // 2nd refresh: the back strand was deleted → design covers no back → cleared
    // to 0 (NOT the stale 55 that would keep billing ~$1,925).
    const cleared = applyPermanentProjection(filled, proj());
    expect(cleared.backFootage).toBe(0);
    expect(cleared.backCorners).toBe(0);
  });

  it("never overwrites a side the operator marked 'manual' (satellite-measured)", () => {
    const fields = {
      ...makeDefaultPermanentFields(),
      backFootage: 40,
      backCorners: 4,
      sideSource: { back: 'manual' as const },
    };
    const out = applyPermanentProjection(
      fields,
      proj({
        feetBySide: { front: 100, left: 0, right: 0, back: 0, unassigned: 0 },
        cornersBySide: { front: 2, left: 0, right: 0, back: 0, unassigned: 0 },
      }),
    );
    expect(out.frontFootage).toBe(100); // design covers front
    expect(out.backFootage).toBe(40); // manual back preserved
    expect(out.backCorners).toBe(4);
  });

  it("keeps a hand-typed value even when the design STILL covers that side (S29 bug)", () => {
    // The operator drew a front run (auto 65), then hand-typed front = 80 (→ 'manual').
    // A Refresh while the run is still there must NOT snap it back to the design's 65.
    const fields = {
      ...makeDefaultPermanentFields(),
      frontFootage: 80,
      frontCorners: 4,
      sideSource: { front: 'manual' as const },
    };
    const out = applyPermanentProjection(
      fields,
      proj({
        feetBySide: { front: 65, left: 0, right: 0, back: 0, unassigned: 0 },
        cornersBySide: { front: 9, left: 0, right: 0, back: 0, unassigned: 0 },
      }),
    );
    expect(out.frontFootage).toBe(80); // hand-typed override wins over the drawn run
    expect(out.frontCorners).toBe(4);
    expect(out.sideSource?.front).toBe('manual'); // stays manual
  });
});
