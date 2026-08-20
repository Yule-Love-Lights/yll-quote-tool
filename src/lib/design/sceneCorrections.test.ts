// src/lib/design/sceneCorrections.test.ts
//
// #840 review fix: isEditableMini()'s isMiniArea return had no groupId guard
// (the isStrand branch right above it does: `item.bulbType === 'mini' &&
// !item.groupId`), so a grouped scattershot showed up as an individually-
// editable mini item in the training-example correction UI — staff could
// "correct" its stringCount even though that field is superseded by the
// group's own stringCount, desyncing the correction from what's actually
// billed. No test file existed for this module before this one.

import { describe, it, expect } from 'vitest';
import { editableItems, applyItemCorrections } from './sceneCorrections';
import type { Scene, SceneItem, StrandItem, MiniAreaItem, MiniGroupItem, SpritzerItem } from './sceneTypes';

let n = 0;
const nextId = () => `item-${++n}`;

function strand(over: Partial<StrandItem> = {}): StrandItem {
  return {
    id: nextId(), yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6,
    drawingStyle: 'strand', colorPattern: ['warm'], points: [0, 0, 10, 0], surface: 'bush', stringCount: 1,
    ...over,
  };
}
function area(over: Partial<MiniAreaItem> = {}): MiniAreaItem {
  return { id: nextId(), yardstickId: null, kind: 'miniArea', shape: 'box', surface: 'bush', stringCount: 1, ...over };
}
function group(over: Partial<MiniGroupItem> = {}): MiniGroupItem {
  return { id: nextId(), yardstickId: null, kind: 'miniGroup', memberIds: [], surface: 'railing', stringCount: 3, ...over };
}
function spritzer(over: Partial<SpritzerItem> = {}): SpritzerItem {
  return { id: nextId(), yardstickId: null, kind: 'spritzer', x: 0, y: 0, sizeIn: 24, colorPattern: ['warm'], ...over };
}
function scene(items: SceneItem[]): Scene {
  return { yardsticks: [], items };
}

describe('editableItems — mini items (#240 grouped-scattershot guard)', () => {
  it('an ungrouped mini strand is editable', () => {
    const s = strand({ id: 's1', stringCount: 2 });
    expect(editableItems(scene([s]))).toEqual([{ id: 's1', kind: 'mini', surface: 'bush', stringCount: 2 }]);
  });

  it('a GROUPED mini strand is NOT individually editable (pre-existing guard)', () => {
    const s = strand({ id: 's1', groupId: 'g1' });
    expect(editableItems(scene([s]))).toEqual([]);
  });

  it('an ungrouped scattershot (miniArea) is editable', () => {
    const a = area({ id: 'a1', surface: 'tree', stringCount: 4 });
    expect(editableItems(scene([a]))).toEqual([{ id: 'a1', kind: 'mini', surface: 'tree', stringCount: 4 }]);
  });

  it('a GROUPED scattershot (miniArea) is NOT individually editable', () => {
    const a = area({ id: 'a1', surface: 'tree', stringCount: 4, groupId: 'g1' });
    expect(editableItems(scene([a]))).toEqual([]);
  });

  it('a miniGroup itself is always editable (its count IS the billed count)', () => {
    const g = group({ id: 'g1', surface: 'railing', stringCount: 5 });
    expect(editableItems(scene([g]))).toEqual([{ id: 'g1', kind: 'mini', surface: 'railing', stringCount: 5 }]);
  });

  it('a mixed scene: group + its grouped strand + its grouped scattershot → only the group is editable', () => {
    const s = strand({ id: 's1', surface: 'railing', groupId: 'g1' });
    const a = area({ id: 'a1', surface: 'railing', groupId: 'g1' });
    const g = group({ id: 'g1', surface: 'railing', stringCount: 5, memberIds: ['s1', 'a1'] });
    expect(editableItems(scene([s, a, g]))).toEqual([{ id: 'g1', kind: 'mini', surface: 'railing', stringCount: 5 }]);
  });

  it('an item on a non-mini surface is not editable as mini', () => {
    const a = area({ id: 'a1', surface: undefined });
    expect(editableItems(scene([a]))).toEqual([]);
  });

  it('a spritzer is editable as its own kind, unaffected', () => {
    const sp = spritzer({ id: 'sp1', quoteSize: '16' });
    expect(editableItems(scene([sp]))).toEqual([{ id: 'sp1', kind: 'spritzer', quoteSize: '16' }]);
  });
});

describe('applyItemCorrections — a GROUPED scattershot ignores a stringCount correction (#240)', () => {
  it('applies a stringCount correction to an ungrouped scattershot', () => {
    const a = area({ id: 'a1', surface: 'bush', stringCount: 1 });
    const out = applyItemCorrections(scene([a]), { a1: { stringCount: 9 } });
    expect((out.items[0] as MiniAreaItem).stringCount).toBe(9);
  });

  it('ignores a stringCount correction targeting a GROUPED scattershot (item unchanged)', () => {
    const a = area({ id: 'a1', surface: 'bush', stringCount: 1, groupId: 'g1' });
    const out = applyItemCorrections(scene([a]), { a1: { stringCount: 9 } });
    expect((out.items[0] as MiniAreaItem).stringCount).toBe(1); // unchanged — the group owns this count
  });

  it('ignores a stringCount correction targeting a GROUPED strand (pre-existing guard, now covered)', () => {
    const s = strand({ id: 's1', surface: 'bush', stringCount: 1, groupId: 'g1' });
    const out = applyItemCorrections(scene([s]), { s1: { stringCount: 9 } });
    expect((out.items[0] as StrandItem).stringCount).toBe(1); // unchanged
  });

  it('applies a stringCount correction to a miniGroup itself', () => {
    const g = group({ id: 'g1', surface: 'railing', stringCount: 3 });
    const out = applyItemCorrections(scene([g]), { g1: { stringCount: 7 } });
    expect((out.items[0] as MiniGroupItem).stringCount).toBe(7);
  });
});
