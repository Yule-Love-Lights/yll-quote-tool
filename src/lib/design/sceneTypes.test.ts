import { describe, it, expect } from 'vitest';
import { isItemOnPhoto, isLinkedTwin, isMiniGroupable, pruneOrphanedMiniGroups, removeItemsForPhoto } from './sceneTypes';
import type { SceneItem, StrandItem, MiniAreaItem, MiniGroupItem, WreathItem } from './sceneTypes';

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
  function mkArea(over: Partial<MiniAreaItem> = {}): MiniAreaItem {
    return { id: 'a1', yardstickId: null, kind: 'miniArea', shape: 'box', ...over };
  }
  function mkGroup(over: Partial<MiniGroupItem> = {}): MiniGroupItem {
    return { id: 'g1', yardstickId: null, kind: 'miniGroup', memberIds: [], surface: 'bush', stringCount: 3, ...over };
  }

  // #240: a group's members can be strands AND/OR scattershots (miniArea).
  it('keeps a mixed-membership group alive when only its scattershot member survives', () => {
    const items: SceneItem[] = [
      mkArea({ id: 'a1' }), // the one survivor; s1 already deleted
      mkGroup({ id: 'g1', memberIds: ['s1', 'a1'] }),
    ];
    expect(pruneOrphanedMiniGroups(items)).toEqual(items);
  });

  it('drops a mixed-membership group once BOTH its strand and its scattershot member are gone', () => {
    const items: SceneItem[] = [mkGroup({ id: 'g1', memberIds: ['s1', 'a1'] })];
    expect(pruneOrphanedMiniGroups(items)).toEqual([]);
  });

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

  // #13 x #240 (fix round on twin-group-stamp-and-ordinals, item 1): a
  // TWINNED group's canonical can vanish through a path that never touches
  // the twin's OWN members at all (Ungroup filters the canonical by id
  // directly, with no twin-awareness) — the existing member-survival rule
  // above can't see this, because the twin group's own members are alive.
  it('drops a TWIN group whose canonical no longer exists, even though its own members are alive, and clears the members\' groupId', () => {
    const items: SceneItem[] = [
      mkArea({ id: 'tm1', groupId: 'twin-g' }),
      mkArea({ id: 'tm2', groupId: 'twin-g' }),
      mkGroup({ id: 'twin-g', memberIds: ['tm1', 'tm2'], linkedToId: 'canonical-g-that-is-gone' }),
    ];
    const after = pruneOrphanedMiniGroups(items);
    expect(after.find((i) => i.id === 'twin-g')).toBeUndefined();
    // Members survive standalone, groupId cleared (mirrors what Ungroup does
    // for the canonical side) rather than secretly still tagged to a group
    // that no longer exists.
    expect(after.find((i) => i.id === 'tm1')).toMatchObject({ id: 'tm1' });
    expect((after.find((i) => i.id === 'tm1') as MiniAreaItem).groupId).toBeUndefined();
    expect((after.find((i) => i.id === 'tm2') as MiniAreaItem).groupId).toBeUndefined();
  });

  it('keeps a TWIN group whose canonical DOES exist (linkedToId resolves)', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 'c1' }),
      mkGroup({ id: 'canonical-g', memberIds: ['c1'] }),
      mkArea({ id: 'tm1', groupId: 'twin-g' }),
      mkGroup({ id: 'twin-g', memberIds: ['tm1'], linkedToId: 'canonical-g' }),
    ];
    expect(pruneOrphanedMiniGroups(items)).toEqual(items);
  });

  it('drops a dangling SINGLE-ITEM twin (not a group) whose canonical no longer exists', () => {
    // Generalizes beyond groups: before this fix, #227's own rule only ever
    // inspected miniGroup items, so a dangling single-item twin (e.g. a
    // wreath whose canonical died via an un-cascaded delete path) was
    // equally orphaned and equally invisible to any existing check.
    const items: SceneItem[] = [
      mkStrand({ id: 'dangling-twin-strand', linkedToId: 'dead-canonical-id' }),
      mkStrand({ id: 'healthy' }),
    ];
    expect(pruneOrphanedMiniGroups(items)).toEqual([items[1]]);
  });
});

// #741 defect 1 (round 2): removeItemsForPhoto is the ONE filter shared by
// editor.ts's live-scene splice (removePhotoItems) AND its undo/redo history
// rewrite — every `past`/`future` snapshot gets scrubbed through this same
// function so no undo/redo step can resurrect a deleted photo's items.
describe('removeItemsForPhoto (#741 defect 1)', () => {
  const P1 = 'aaaa1111-2222-4333-8444-555566667777';
  const P2 = 'bbbb1111-2222-4333-8444-555566667777';
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

  it('returns the SAME array reference when nothing is tagged to the photo', () => {
    const items: SceneItem[] = [mkStrand({ id: 's1', photoId: P2 })];
    expect(removeItemsForPhoto(items, P1)).toBe(items);
  });

  it('drops every item tagged to the photo, keeps everything else', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 's1', photoId: P1 }),
      mkStrand({ id: 's2', photoId: P2 }),
      mkStrand({ id: 's3' }), // base photo (no photoId)
    ];
    expect(removeItemsForPhoto(items, P1)).toEqual([items[1], items[2]]);
  });

  it('also drops a linked twin of a dropped canonical, even though the twin itself is tagged to a DIFFERENT photo', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 'canonical', photoId: P1 }),
      mkStrand({ id: 'twin', photoId: P2, linkedToId: 'canonical' }),
    ];
    expect(removeItemsForPhoto(items, P1)).toEqual([]);
  });

  it('prunes a miniGroup left with zero surviving members once its strands are dropped', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 's1', photoId: P1 }),
      mkGroup({ id: 'g1', memberIds: ['s1'] }),
    ];
    expect(removeItemsForPhoto(items, P1)).toEqual([]);
  });

  it('keeps a miniGroup that still has a surviving member on another photo', () => {
    const items: SceneItem[] = [
      mkStrand({ id: 's1', photoId: P1 }),
      mkStrand({ id: 's2', photoId: P2 }),
      mkGroup({ id: 'g1', memberIds: ['s1', 's2'] }),
    ];
    expect(removeItemsForPhoto(items, P1)).toEqual([items[1], items[2]]);
  });

  it('is safe to re-apply to an already-scrubbed snapshot (undo/redo history rewrite runs it on every entry)', () => {
    const items: SceneItem[] = [mkStrand({ id: 's2', photoId: P2 })];
    const once = removeItemsForPhoto(items, P1);
    expect(removeItemsForPhoto(once, P1)).toBe(once);
  });
});

// #240: the single shared gate every "select 2+ → group" affordance uses
// (strand-only, scattershot-only, and mixed selections all call this same
// function so their eligibility rules can't drift apart).
describe('isMiniGroupable (#240)', () => {
  function mkStrand(over: Partial<StrandItem> = {}): StrandItem {
    return {
      id: 's1', yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6,
      drawingStyle: 'strand', colorPattern: ['warm'], points: [0, 0, 10, 0],
      ...over,
    };
  }
  function mkArea(over: Partial<MiniAreaItem> = {}): MiniAreaItem {
    return { id: 'a1', yardstickId: null, kind: 'miniArea', shape: 'box', ...over };
  }
  function mkWreath(over: Partial<WreathItem> = {}): WreathItem {
    return { id: 'w1', yardstickId: null, kind: 'wreath', x: 0, y: 0, sizeIn: 60, withLights: true, ...over };
  }

  it('a plain mini strand is groupable', () => {
    expect(isMiniGroupable(mkStrand())).toBe(true);
  });
  it('a c9/permanent/bistro strand is NOT groupable (only mini bulbs wrap into a group)', () => {
    expect(isMiniGroupable(mkStrand({ bulbType: 'c9' }))).toBe(false);
    expect(isMiniGroupable(mkStrand({ bulbType: 'permanent' }))).toBe(false);
    expect(isMiniGroupable(mkStrand({ bulbType: 'bistro' }))).toBe(false);
  });
  it('a plain scattershot (miniArea) is groupable', () => {
    expect(isMiniGroupable(mkArea())).toBe(true);
  });
  it('an already-grouped strand or scattershot is NOT groupable', () => {
    expect(isMiniGroupable(mkStrand({ groupId: 'g1' }))).toBe(false);
    expect(isMiniGroupable(mkArea({ groupId: 'g1' }))).toBe(false);
  });
  it('a #13 linked twin (strand or scattershot) is NOT groupable', () => {
    expect(isMiniGroupable(mkStrand({ linkedToId: 'canonical' }))).toBe(false);
    expect(isMiniGroupable(mkArea({ linkedToId: 'canonical' }))).toBe(false);
  });
  it('a non-mini-light item kind is never groupable', () => {
    expect(isMiniGroupable(mkWreath())).toBe(false);
  });
});
