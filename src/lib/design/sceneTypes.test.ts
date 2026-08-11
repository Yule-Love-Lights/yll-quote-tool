import { describe, it, expect } from 'vitest';
import { isItemOnPhoto, isLinkedTwin, pruneOrphanedMiniGroups } from './sceneTypes';
import type { SceneItem, StrandItem, MiniGroupItem } from './sceneTypes';

// #13 multi-image: the one predicate both the editor's per-photo filtering and
// the portal's per-photo rendering hang off. null/absent photoId = the BASE
// photo on both sides.

describe('isItemOnPhoto (#13)', () => {
  const P1 = 'aaaa1111-2222-4333-8444-555566667777';

  it('legacy items (no photoId) belong to the base mount only', () => {
    expect(isItemOnPhoto({}, null)).toBe(true);
    expect(isItemOnPhoto({ photoId: undefined }, null)).toBe(true);
    expect(isItemOnPhoto({ photoId: null }, null)).toBe(true);
    expect(isItemOnPhoto({}, P1)).toBe(false);
    expect(isItemOnPhoto({ photoId: null }, P1)).toBe(false);
  });

  it('stamped items belong to their photo only', () => {
    expect(isItemOnPhoto({ photoId: P1 }, P1)).toBe(true);
    expect(isItemOnPhoto({ photoId: P1 }, null)).toBe(false);
    expect(isItemOnPhoto({ photoId: P1 }, 'other-id')).toBe(false);
  });
});

describe('isLinkedTwin (#13)', () => {
  it('true only when linkedToId is set', () => {
    expect(isLinkedTwin({ linkedToId: 'abc' })).toBe(true);
    expect(isLinkedTwin({})).toBe(false);
    expect(isLinkedTwin({ linkedToId: null })).toBe(false);
  });
});

// #227: pruneOrphanedMiniGroups is the ONE shared helper every strand-removal
// site (deleteSelected, the sidebar strand row ×, both yardstick-delete paths,
// and the server-side photo-delete prune) calls after removing strand items,
// so a miniGroup left with zero surviving members never survives that edit.
describe('pruneOrphanedMiniGroups (#227)', () => {
  function mkStrand(over: Partial<StrandItem> = {}): StrandItem {
    return {
      id: 's1', yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6,
      drawingStyle: 'strand', colorPattern: ['warm'], points: [0, 0, 10, 0],
      ...over,
    };
  }
  function mkGroup(over: Partial<MiniGroupItem> = {}): MiniGroupItem {
    return { id: 'g1', yardstickId: null, kind: 'miniGroup', memberIds: [], surface: 'bush', stringCount: 3, ...over };
  }

  it('drops a miniGroup whose members are ALL gone from items', () => {
    const items: SceneItem[] = [mkGroup({ id: 'g1', memberIds: ['s1', 's2'] })];
    // Neither s1 nor s2 is present in `items` — fully orphaned.
    expect(pruneOrphanedMiniGroups(items)).toEqual([]);
  });

  it('keeps a miniGroup with at least one surviving member (partial orphan bills normally)', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 's1' }),
      mkGroup({ id: 'g1', memberIds: ['s1', 's2', 's3'] }), // s2/s3 already deleted
    ];
    expect(pruneOrphanedMiniGroups(items)).toEqual(items);
  });

  it('keeps a fully healthy miniGroup untouched', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 's1' }),
      mkStrand({ id: 's2' }),
      mkGroup({ id: 'g1', memberIds: ['s1', 's2'] }),
    ];
    expect(pruneOrphanedMiniGroups(items)).toEqual(items);
  });

  it('leaves a zero-member miniGroup alone (not the bug this targets)', () => {
    const items: SceneItem[] = [mkGroup({ id: 'g0', memberIds: [] })];
    expect(pruneOrphanedMiniGroups(items)).toEqual(items);
  });

  it('leaves non-miniGroup items untouched and preserves order', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 's1' }),
      mkGroup({ id: 'g1', memberIds: ['dead-1', 'dead-2'] }),
      mkStrand({ id: 's2' }),
    ];
    expect(pruneOrphanedMiniGroups(items)).toEqual([items[0], items[2]]);
  });

  it('removing the LAST surviving member in the same batch orphans the group', () => {
    // Simulates deleteSelected() removing both remaining members in one delete.
    const before: SceneItem[] = [
      mkStrand({ id: 's1' }),
      mkStrand({ id: 's2' }),
      mkGroup({ id: 'g1', memberIds: ['s1', 's2'] }),
    ];
    const afterRemoval = before.filter((i) => i.id !== 's1' && i.id !== 's2'); // just the group left
    expect(pruneOrphanedMiniGroups(afterRemoval)).toEqual([]);
  });
});
