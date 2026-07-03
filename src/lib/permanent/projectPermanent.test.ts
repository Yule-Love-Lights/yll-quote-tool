import { describe, it, expect } from 'vitest';
import { projectPermanentDesign } from './projectPermanent';
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
