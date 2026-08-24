import { describe, expect, it } from 'vitest';
import { projectScene } from './projectScene';
import {
  addMiniGroupMembers,
  createMiniGroup,
  resolveMiniGroupSelection,
  setMiniGroupMemberSpacing,
  sharedMiniGroupColorPattern,
  updateSelectedColorPatterns,
  updateMiniGroupMemberColorPatterns,
} from './miniGroupEdits';
import type { MiniAreaItem, MiniGroupItem, Scene, SceneItem, StrandItem } from './sceneTypes';

function strand(id: string, over: Partial<StrandItem> = {}): StrandItem {
  return {
    id,
    yardstickId: null,
    kind: 'strand',
    bulbType: 'mini',
    spacingIn: 6,
    drawingStyle: 'strand',
    colorPattern: ['warm-white'],
    points: [0, 0, 100, 0],
    surface: 'bush',
    stringCount: 1,
    ...over,
  };
}

function area(id: string, over: Partial<MiniAreaItem> = {}): MiniAreaItem {
  return {
    id,
    yardstickId: null,
    kind: 'miniArea',
    shape: 'box',
    x: 10,
    y: 20,
    width: 50,
    height: 60,
    colorPattern: ['warm-white'],
    surface: 'bush',
    stringCount: 1,
    ...over,
  };
}

function group(id: string, memberIds: string[], over: Partial<MiniGroupItem> = {}): MiniGroupItem {
  return {
    id,
    yardstickId: null,
    kind: 'miniGroup',
    memberIds,
    surface: 'railing',
    wrapStyle: 'trunk',
    stringCount: 3,
    included: false,
    ...over,
  };
}

function scene(items: SceneItem[]): Scene {
  return { yardsticks: [], items };
}

describe('resolveMiniGroupSelection', () => {
  it('finds one existing group plus eligible ungrouped minis regardless of scene order', () => {
    const items: SceneItem[] = [
      strand('new-strand'),
      area('new-area'),
      strand('member', { groupId: 'group-1' }),
      group('group-1', ['member'], { included: true, colorPattern: ['red', 'green'] }),
    ];

    const resolved = resolveMiniGroupSelection(items, new Set(['member', 'new-strand', 'new-area']));

    expect(resolved?.group.id).toBe('group-1');
    expect(resolved?.addableMembers.map((item) => item.id)).toEqual(['new-strand', 'new-area']);
  });

  it('still resolves the existing group when no new members are selected', () => {
    const items: SceneItem[] = [strand('member', { groupId: 'group-1' }), group('group-1', ['member'])];

    expect(resolveMiniGroupSelection(items, new Set(['member']))).toEqual({
      group: items[1],
      addableMembers: [],
    });
  });

  it('rejects ambiguous groups, missing groups, and ineligible extras', () => {
    const firstMember = strand('first', { groupId: 'group-1' });
    const secondMember = strand('second', { groupId: 'group-2' });
    const firstGroup = group('group-1', ['first']);
    const secondGroup = group('group-2', ['second']);

    expect(resolveMiniGroupSelection(
      [firstMember, secondMember, firstGroup, secondGroup],
      new Set(['first', 'second']),
    )).toBeNull();
    expect(resolveMiniGroupSelection([firstMember], new Set(['first']))).toBeNull();
    expect(resolveMiniGroupSelection(
      [firstMember, firstGroup, strand('c9', { bulbType: 'c9' })],
      new Set(['first', 'c9']),
    )).toBeNull();
    expect(resolveMiniGroupSelection(
      [firstMember, firstGroup, strand('twin', { linkedToId: 'canonical' })],
      new Set(['first', 'twin']),
    )).toBeNull();
    expect(resolveMiniGroupSelection(
      [strand('stale-backref', { groupId: 'group-1' }), firstGroup],
      new Set(['stale-backref']),
    )).toBeNull();
  });
});

describe('sharedMiniGroupColorPattern', () => {
  it('returns a copied pattern only when every prospective member matches', () => {
    const members = [
      strand('left', { colorPattern: ['red', 'green'] }),
      area('right', { colorPattern: ['red', 'green'] }),
    ];

    const pattern = sharedMiniGroupColorPattern(members);

    expect(pattern).toEqual(['red', 'green']);
    expect(pattern).not.toBe(members[0].colorPattern);
  });

  it('rejects mixed-pattern and empty prospective groups', () => {
    expect(sharedMiniGroupColorPattern([
      strand('left', { colorPattern: ['red'] }),
      area('right', { colorPattern: ['green'] }),
    ])).toBeNull();
    expect(sharedMiniGroupColorPattern([])).toBeNull();
  });
});

describe('createMiniGroup', () => {
  it('creates one canonical-pattern group without changing the member counts', () => {
    const original = scene([
      strand('left', { colorPattern: ['red', 'green'], stringCount: 4 }),
      area('right', { colorPattern: ['red', 'green'], stringCount: 7 }),
    ]);
    const candidate = group('group-1', ['left', 'right'], {
      stringCount: 2,
      included: true,
      colorPattern: undefined,
    });

    const updated = createMiniGroup(original, candidate);

    expect(updated.items.find((item) => item.id === 'group-1')).toMatchObject({
      memberIds: ['left', 'right'],
      stringCount: 2,
      colorPattern: ['red', 'green'],
    });
    expect(updated.items.find((item) => item.id === 'left')).toMatchObject({
      groupId: 'group-1',
      stringCount: 4,
      colorPattern: ['red', 'green'],
    });
    expect(updated.items.find((item) => item.id === 'right')).toMatchObject({
      groupId: 'group-1',
      stringCount: 7,
      colorPattern: ['red', 'green'],
    });
    expect(projectScene(updated).miniLightItems).toEqual([
      { type: 'railing', wrapStyle: 'trunk', stringCount: 2 },
    ]);
    expect(createMiniGroup(updated, candidate)).toBe(updated);
  });

  it('rejects mixed-pattern members instead of creating a warm-white fulfillment fallback', () => {
    const original = scene([
      strand('left', { colorPattern: ['red'] }),
      area('right', { colorPattern: ['green'] }),
    ]);

    expect(createMiniGroup(original, group('group-1', ['left', 'right']))).toBe(original);
  });
});

describe('addMiniGroupMembers', () => {
  it('adopts selected strands and scattershots without changing the billed group count', () => {
    const original = scene([
      strand('member', { groupId: 'group-1', colorPattern: ['red'], spacingIn: 4 }),
      strand('new-strand', { colorPattern: ['green', 'blue'], spacingIn: 8, stringCount: 9 }),
      area('new-area', { colorPattern: ['blue', 'red'], stringCount: 7 }),
      group('group-1', ['member'], { included: true, colorPattern: ['red', 'green'] }),
    ]);

    const updated = addMiniGroupMembers(original, 'group-1', ['new-strand', 'new-area']);
    const updatedGroup = updated.items.find((item): item is MiniGroupItem => item.kind === 'miniGroup')!;
    const updatedStrand = updated.items.find((item): item is StrandItem => item.id === 'new-strand')!;
    const updatedArea = updated.items.find((item): item is MiniAreaItem => item.id === 'new-area')!;

    expect(updated).not.toBe(original);
    expect(original.items.find((item) => item.id === 'new-strand')).not.toHaveProperty('groupId');
    expect(updatedGroup).toMatchObject({
      memberIds: ['member', 'new-strand', 'new-area'],
      surface: 'railing',
      wrapStyle: 'trunk',
      stringCount: 3,
      included: true,
      colorPattern: ['red', 'green'],
    });
    expect(updatedStrand).toMatchObject({
      groupId: 'group-1',
      colorPattern: ['red', 'green'],
      spacingIn: 8,
      stringCount: 9,
      points: [0, 0, 100, 0],
    });
    expect(updatedArea).toMatchObject({
      groupId: 'group-1',
      colorPattern: ['red', 'green'],
      stringCount: 7,
      x: 10,
      y: 20,
      width: 50,
      height: 60,
    });

    const projected = projectScene(updated);
    expect(projected.miniLightItems).toEqual([{ type: 'railing', wrapStyle: 'trunk', stringCount: 3 }]);
    expect(projected.items).toEqual([
      {
        id: 'mini-group-1',
        category: 'mini',
        sceneItemIds: ['member', 'new-strand', 'new-area'],
        input: { type: 'railing', wrapStyle: 'trunk', stringCount: 3 },
        recommended: undefined,
      },
    ]);
  });

  it('ignores linked twins, non-mini strands, foreign-group members, and unknown ids', () => {
    const original = scene([
      strand('member', { groupId: 'group-1' }),
      strand('twin', { linkedToId: 'canonical' }),
      strand('c9', { bulbType: 'c9' }),
      area('foreign', { groupId: 'group-2' }),
      group('group-1', ['member'], { included: true }),
      group('group-2', ['foreign']),
    ]);

    expect(addMiniGroupMembers(original, 'group-1', ['twin', 'c9', 'foreign', 'missing'])).toBe(original);
  });

  it('is idempotent and never duplicates member ids', () => {
    const original = scene([
      strand('member', { groupId: 'group-1' }),
      strand('new-strand'),
      group('group-1', ['member'], { included: true }),
    ]);

    const once = addMiniGroupMembers(original, 'group-1', ['new-strand', 'new-strand']);
    const twice = addMiniGroupMembers(once, 'group-1', ['new-strand']);

    expect(twice).toBe(once);
    expect((twice.items.find((item) => item.id === 'group-1') as MiniGroupItem).memberIds).toEqual([
      'member',
      'new-strand',
    ]);
    expect(projectScene(twice).miniLightItems).toEqual([
      { type: 'railing', wrapStyle: 'trunk', stringCount: 3 },
    ]);
  });

  it('does not add to a legacy mixed-color group until one group pattern is chosen', () => {
    const original = scene([
      strand('left', { groupId: 'group-1', colorPattern: ['red'] }),
      strand('right', { groupId: 'group-1', colorPattern: ['green'] }),
      strand('new-strand', { colorPattern: ['blue'] }),
      group('group-1', ['left', 'right']),
    ]);

    expect(addMiniGroupMembers(original, 'group-1', ['new-strand'])).toBe(original);
  });
});

describe('mini-group appearance edits', () => {
  it('changes spacing on strand members only', () => {
    const original = scene([
      strand('left', { groupId: 'group-1', spacingIn: 4 }),
      area('middle', { groupId: 'group-1' }),
      strand('right', { groupId: 'group-1', spacingIn: 8 }),
      strand('outside', { spacingIn: 10 }),
      group('group-1', ['left', 'middle', 'right']),
    ]);

    const updated = setMiniGroupMemberSpacing(original, 'group-1', 6);

    expect(updated.items.find((item) => item.id === 'left')).toMatchObject({ spacingIn: 6 });
    expect(updated.items.find((item) => item.id === 'right')).toMatchObject({ spacingIn: 6 });
    expect(updated.items.find((item) => item.id === 'middle')).not.toHaveProperty('spacingIn');
    expect(updated.items.find((item) => item.id === 'outside')).toMatchObject({ spacingIn: 10 });
    expect(updated.items.find((item) => item.id === 'group-1')).toEqual(original.items[4]);
  });

  it('keeps each selected group authoritative when a bulk color edit spans groups', () => {
    const original = scene([
      strand('first-selected', { groupId: 'group-1', colorPattern: ['red'] }),
      area('first-sibling', { groupId: 'group-1', colorPattern: ['red'] }),
      strand('second-selected', { groupId: 'group-2', colorPattern: ['green'] }),
      strand('second-sibling', { groupId: 'group-2', colorPattern: ['green'] }),
      strand('ungrouped', { colorPattern: ['warm-white'] }),
      group('group-1', ['first-selected', 'first-sibling'], { colorPattern: ['red'] }),
      group('group-2', ['second-selected', 'second-sibling'], { colorPattern: ['green'] }),
    ]);

    const updated = updateSelectedColorPatterns(
      original,
      new Set(['first-selected', 'second-selected', 'ungrouped']),
      () => ['blue'],
    );

    for (const id of [
      'first-selected',
      'first-sibling',
      'second-selected',
      'second-sibling',
      'ungrouped',
      'group-1',
      'group-2',
    ]) {
      expect(updated.items.find((item) => item.id === id)).toMatchObject({ colorPattern: ['blue'] });
    }
  });

  it('updates ordered color patterns on strand and scattershot members only', () => {
    const original = scene([
      strand('left', { groupId: 'group-1', colorPattern: ['red'] }),
      area('middle', { groupId: 'group-1', colorPattern: ['green'] }),
      strand('outside', { colorPattern: ['blue'] }),
      group('group-1', ['left', 'middle']),
    ]);

    const updated = updateMiniGroupMemberColorPatterns(
      original,
      'group-1',
      () => ['red', 'green', 'blue'],
    );

    expect(updated.items.find((item) => item.id === 'left')).toMatchObject({
      colorPattern: ['red', 'green', 'blue'],
    });
    expect(updated.items.find((item) => item.id === 'middle')).toMatchObject({
      colorPattern: ['red', 'green', 'blue'],
    });
    expect(updated.items.find((item) => item.id === 'outside')).toMatchObject({ colorPattern: ['blue'] });
    expect(updated.items.find((item) => item.id === 'group-1')).toMatchObject({
      colorPattern: ['red', 'green', 'blue'],
      stringCount: 3,
    });
  });

  it('can append to each member pattern without sharing mutable arrays', () => {
    const original = scene([
      strand('left', { groupId: 'group-1', colorPattern: ['red'] }),
      area('middle', { groupId: 'group-1', colorPattern: ['green'] }),
      group('group-1', ['left', 'middle']),
    ]);

    const updated = updateMiniGroupMemberColorPatterns(original, 'group-1', (pattern) => [
      ...pattern,
      'blue',
    ]);
    const left = updated.items.find((item) => item.id === 'left') as StrandItem;
    const middle = updated.items.find((item) => item.id === 'middle') as MiniAreaItem;

    expect(left.colorPattern).toEqual(['red', 'blue']);
    expect(middle.colorPattern).toEqual(['red', 'blue']);
    expect(left.colorPattern).not.toBe(middle.colorPattern);
    expect(original.items.find((item) => item.id === 'left')).toMatchObject({ colorPattern: ['red'] });
  });

  it('does not edit a stale forward member whose groupId points elsewhere', () => {
    const original = scene([
      strand('member', { groupId: 'group-1', spacingIn: 4, colorPattern: ['red'] }),
      strand('stale', { groupId: 'group-2', spacingIn: 8, colorPattern: ['green'] }),
      group('group-1', ['member', 'stale']),
      group('group-2', ['stale']),
    ]);

    const spaced = setMiniGroupMemberSpacing(original, 'group-1', 12);
    const colored = updateMiniGroupMemberColorPatterns(spaced, 'group-1', () => ['blue']);

    expect(colored.items.find((item) => item.id === 'member')).toMatchObject({
      spacingIn: 12,
      colorPattern: ['blue'],
    });
    expect(colored.items.find((item) => item.id === 'stale')).toMatchObject({
      groupId: 'group-2',
      spacingIn: 8,
      colorPattern: ['green'],
    });
  });
});
