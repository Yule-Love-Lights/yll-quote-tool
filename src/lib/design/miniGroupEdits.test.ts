import { describe, expect, it } from 'vitest';
import { projectScene } from './projectScene';
import {
  addMiniGroupMembers,
  createMiniGroup,
  resolveMiniGroupSelection,
  setMiniGroupMemberSpacing,
  sharedMiniGroupColorPattern,
  twinMiniGroupAt,
  updateSelectedColorPatterns,
  updateMiniGroupMemberColorPatterns,
} from './miniGroupEdits';
import { pruneOrphanedMiniGroups } from './sceneTypes';
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

describe('twinMiniGroupAt', () => {
  function idGen(prefix: string) {
    let n = 0;
    return () => `${prefix}-${++n}`;
  }

  // THE MOST IMPORTANT TEST IN THIS BUILD (row: twin-group-stamp): a grouped
  // railing bills ONCE today; re-placing it onto a second photo must add
  // ZERO new billable units, because projectScene skips any item carrying
  // `linkedToId` (the twin group AND its twinned members all get one) before
  // it ever reaches the isMiniGroup/isStrand/isMiniArea branches — see
  // projectScene.ts line ~177. Written first, per the build brief.
  it('bills exactly once before AND after stamping a group onto a second photo', () => {
    const original = scene([
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0], colorPattern: ['red'] }),
      strand('m2', { groupId: 'g1', points: [0, 30, 20, 30], colorPattern: ['red'] }),
      group('g1', ['m1', 'm2'], { surface: 'column', stringCount: 2, included: true }),
    ]);
    expect(projectScene(original).miniLightItems).toEqual([
      { type: 'column', wrapStyle: 'trunk', stringCount: 2 },
    ]);

    const g1 = original.items.find((i): i is MiniGroupItem => i.id === 'g1')!;
    const result = twinMiniGroupAt(original, g1, { x: 500, y: 500 }, {
      activePhotoId: 'extra-1',
      idGen: idGen('twin'),
    });
    expect(result).not.toBeNull();
    const stamped = result!.scene;

    // The original 3 items (2 members + the group) plus the twin group and
    // its 2 twinned members = 6 items total...
    expect(stamped.items).toHaveLength(6);
    // ...but the billed count is UNCHANGED: still exactly one mini unit, same
    // stringCount, because every twinned item carries linkedToId.
    const projected = projectScene(stamped);
    expect(projected.miniLightItems).toEqual([
      { type: 'column', wrapStyle: 'trunk', stringCount: 2 },
    ]);
    expect(projected.miniLightItems).toHaveLength(1);
  });

  it('twins the group AND every live member as ONE unit, with fresh ids pointing at each other (not the canonical)', () => {
    const original = scene([
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0], colorPattern: ['red'] }),
      strand('m2', { groupId: 'g1', points: [0, 30, 20, 30], colorPattern: ['red'] }),
      group('g1', ['m1', 'm2'], {
        surface: 'railing',
        wrapStyle: 'trunk',
        stringCount: 5,
        colorPattern: ['red'],
        included: true,
      }),
    ]);
    const g1 = original.items.find((i): i is MiniGroupItem => i.id === 'g1')!;

    const result = twinMiniGroupAt(original, g1, { x: 100, y: 65 }, {
      activePhotoId: 'extra-1',
      idGen: idGen('twin'),
    });
    expect(result).not.toBeNull();
    const { scene: stamped, groupId, memberIds } = result!;

    expect(groupId).not.toBe('g1');
    expect(memberIds).toHaveLength(2);
    expect(memberIds).not.toContain('m1');
    expect(memberIds).not.toContain('m2');

    const twinGroup = stamped.items.find((i): i is MiniGroupItem => i.id === groupId)!;
    expect(twinGroup).toMatchObject({
      kind: 'miniGroup',
      linkedToId: 'g1',
      photoId: 'extra-1',
      surface: 'railing',
      wrapStyle: 'trunk',
      stringCount: 5,
      colorPattern: ['red'],
      memberIds,
    });

    const [twinM1, twinM2] = memberIds.map((id) => stamped.items.find((i) => i.id === id)!);
    expect(twinM1).toMatchObject({ groupId, linkedToId: 'm1', photoId: 'extra-1', yardstickId: null });
    expect(twinM2).toMatchObject({ groupId, linkedToId: 'm2', photoId: 'extra-1', yardstickId: null });

    // Neither twin member points at the CANONICAL group — getting this
    // backwards would silently corrupt both groups (constraint 2 of the build).
    expect((twinM1 as StrandItem).groupId).toBe(groupId);
    expect((twinM1 as StrandItem).groupId).not.toBe('g1');

    // The canonical scene is untouched (pure function, no in-place mutation).
    expect(original.items).toHaveLength(3);
    expect(original.items.find((i) => i.id === 'g1')).toMatchObject({ memberIds: ['m1', 'm2'] });
  });

  it('preserves each member\'s geometry RELATIVE to the others (a pure translation)', () => {
    // m1 spans (0,0)-(20,0); m2 spans (0,30)-(20,30) — a fixed 30px vertical
    // offset between the two members' centroids in the canonical group.
    const original = scene([
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0] }),
      strand('m2', { groupId: 'g1', points: [0, 30, 20, 30] }),
      group('g1', ['m1', 'm2']),
    ]);
    const g1 = original.items.find((i): i is MiniGroupItem => i.id === 'g1')!;

    const result = twinMiniGroupAt(original, g1, { x: 500, y: 500 }, {
      activePhotoId: 'extra-1',
      idGen: idGen('twin'),
    });
    const [twinM1, twinM2] = result!.memberIds.map(
      (id) => result!.scene.items.find((i) => i.id === id) as StrandItem,
    );

    const centroid = (pts: number[]) => {
      let cx = 0, cy = 0;
      for (let k = 0; k + 1 < pts.length; k += 2) { cx += pts[k]; cy += pts[k + 1]; }
      const n = pts.length / 2;
      return { x: cx / n, y: cy / n };
    };
    const c1 = centroid(twinM1.points);
    const c2 = centroid(twinM2.points);
    expect(c2.y - c1.y).toBeCloseTo(30, 5);
    expect(c2.x - c1.x).toBeCloseTo(0, 5);
  });

  it('shifts a box-shaped miniArea member by the same translation as its point-based siblings', () => {
    const original = scene([
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0] }),
      area('m2', { groupId: 'g1', shape: 'box', x: 5, y: 35, width: 10, height: 10 }),
      group('g1', ['m1', 'm2']),
    ]);
    const g1 = original.items.find((i): i is MiniGroupItem => i.id === 'g1')!;

    // Combined centroid of m1's single point-pair (10,0) and m2's box center
    // (10,40) is (10,20); clicking at (10,120) is a pure +0,+100 shift.
    const result = twinMiniGroupAt(original, g1, { x: 10, y: 120 }, {
      activePhotoId: 'extra-1',
      idGen: idGen('twin'),
    });
    const twinArea = result!.scene.items.find((i) => i.id === result!.memberIds[1]) as MiniAreaItem;
    expect(twinArea.x).toBeCloseTo(5, 5);
    expect(twinArea.y).toBeCloseTo(135, 5);
  });

  // Fix-round item 3 (LOW from the technical lens): liveMembers' guard
  // `item.groupId === group.id` had no test distinguishing it from a bare
  // `group.memberIds.includes(item.id)` check — the lens mutated it to
  // `true` and every existing test stayed green. A "stale forward
  // reference" (mirrors resolveMiniGroupSelection's own stale-backref test
  // above) reproduces exactly the case that guard exists for: g1's own
  // memberIds array still lists an item that has since been re-grouped
  // under g2, and the item's OWN groupId is the source of truth for which
  // group it currently belongs to.
  it('excludes a member whose groupId no longer points at THIS group (a stale forward reference in memberIds)', () => {
    const original = scene([
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0] }),
      // 'stale' was moved to g2, but g1's memberIds array was never updated
      // to drop it (the same stale-backref shape the resolveMiniGroupSelection
      // tests above cover for SELECTION; this is the same shape for TWINNING).
      strand('stale', { groupId: 'g2', points: [0, 30, 20, 30] }),
      group('g1', ['m1', 'stale']),
      group('g2', ['stale']),
    ]);
    const g1 = original.items.find((i): i is MiniGroupItem => i.id === 'g1')!;

    const result = twinMiniGroupAt(original, g1, { x: 100, y: 100 }, {
      activePhotoId: 'extra-1',
      idGen: idGen('twin'),
    });

    expect(result).not.toBeNull();
    // Only m1 is a live member of g1 — 'stale' belongs to g2 now and must
    // NOT be twinned as part of g1's re-placement.
    expect(result!.memberIds).toHaveLength(1);
  });

  it('is a no-op (returns null) when the group has zero live members (#227 fully orphaned)', () => {
    const original = scene([group('g1', ['dead-1', 'dead-2'])]);
    const g1 = original.items[0] as MiniGroupItem;

    const result = twinMiniGroupAt(original, g1, { x: 0, y: 0 }, {
      activePhotoId: 'extra-1',
      idGen: idGen('twin'),
    });
    expect(result).toBeNull();
  });

  it('twins onto the BASE photo (no activePhotoId) without stamping a photoId', () => {
    const original = scene([
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0], photoId: 'extra-1' }),
      strand('m2', { groupId: 'g1', points: [0, 30, 20, 30], photoId: 'extra-1' }),
      group('g1', ['m1', 'm2'], { photoId: 'extra-1' }),
    ]);
    const g1 = original.items.find((i): i is MiniGroupItem => i.id === 'g1')!;

    const result = twinMiniGroupAt(original, g1, { x: 0, y: 0 }, { activePhotoId: null, idGen: idGen('twin') });
    const twinGroup = result!.scene.items.find((i) => i.id === result!.groupId)!;
    expect(twinGroup).not.toHaveProperty('photoId');
  });

  // Build brief constraint 4, UPDATED by the fix-round coordinator: this test
  // originally asserted the twin group SURVIVES a direct (un-cascaded) removal
  // of its canonical — that was the row-1 HIGH the fix round closed. A direct
  // filter-by-id removal of the canonical (mirroring Ungroup / the strand-row
  // x button / a yardstick-cascade delete, none of which check for twins) now
  // leaves the twin group's `linkedToId` dangling, and pruneOrphanedMiniGroups
  // (sceneTypes.ts) has been taught to catch exactly that: it removes any item
  // whose linkedToId no longer resolves, group or not, and clears groupId on
  // any surviving member of a removed group so it reads as a plain standalone
  // item rather than secretly still tagged to a defunct group.
  it('a TWIN group does not survive when its canonical is removed by a DIRECT (un-cascaded) delete — the row-1 fix', () => {
    const original = scene([
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0] }),
      strand('m2', { groupId: 'g1', points: [0, 30, 20, 30] }),
      group('g1', ['m1', 'm2']),
    ]);
    const g1 = original.items.find((i): i is MiniGroupItem => i.id === 'g1')!;
    const result = twinMiniGroupAt(original, g1, { x: 500, y: 500 }, {
      activePhotoId: 'extra-1',
      idGen: idGen('twin'),
    });
    const stamped = result!.scene;

    // Remove the CANONICAL group by id directly (Ungroup's exact shape) —
    // no twin-aware cascade, just like Ungroup/strand-row-delete/yardstick-
    // delete. The canonical MEMBERS are left alive here on purpose: this
    // isolates "canonical group gone, canonical members untouched" from the
    // deleteSelected whole-selection case (already covered elsewhere), which
    // cascades member deletion to twins independently of this rule.
    const afterDelete = pruneOrphanedMiniGroups(
      stamped.items.filter((i) => i.id !== 'g1'),
    );

    // The twin group is GONE — its canonical no longer exists.
    expect(afterDelete.find((i) => i.id === result!.groupId)).toBeUndefined();
    // Its own members survive (their geometry/photo still matter — they
    // still render), but standalone: groupId cleared, not left pointing at
    // a group that no longer exists.
    for (const id of result!.memberIds) {
      const member = afterDelete.find((i) => i.id === id) as StrandItem | undefined;
      expect(member).toBeDefined();
      expect(member!.groupId).toBeUndefined();
    }
  });
});
