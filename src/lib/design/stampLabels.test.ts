import { describe, expect, it } from 'vitest';
import { assignStampOrdinals, backfillStampOrdinals, baseStampLabel, describePrunedItems, numberStampLabels } from './stampLabels';
import { pruneOrphanedMiniGroups } from './sceneTypes';
import type { GarlandItem, MiniAreaItem, MiniGroupItem, Scene, SceneItem, StrandItem, WreathItem } from './sceneTypes';

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
    surface: 'column',
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
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    surface: 'bush',
    ...over,
  };
}

function miniGroup(id: string, memberIds: string[], over: Partial<MiniGroupItem> = {}): MiniGroupItem {
  return { id, yardstickId: null, kind: 'miniGroup', memberIds, surface: 'column', ...over };
}

function wreath(id: string, over: Partial<WreathItem> = {}): WreathItem {
  return { id, yardstickId: null, kind: 'wreath', x: 0, y: 0, sizeIn: 24, withLights: true, ...over };
}

function garland(id: string, over: Partial<GarlandItem> = {}): GarlandItem {
  return {
    id,
    yardstickId: null,
    kind: 'garland',
    points: [0, 0, 10, 0],
    drawingStyle: 'strand',
    withLights: true,
    ...over,
  };
}

function scene(items: SceneItem[], over: Partial<Scene> = {}): Scene {
  return { yardsticks: [], items, ...over };
}

// Test helper matching editor.ts's own stampLabel() wiring: assign any
// missing stampOrdinals first (persisted, stable), THEN read the numbered
// labels off the result. Every numberStampLabels test below goes through
// this — numberStampLabels alone only ever READS an item's own
// stampOrdinal; it never computes one.
function numbered(items: SceneItem[]): Map<string, string> {
  return numberStampLabels(assignStampOrdinals(scene(items)).items);
}

describe('baseStampLabel', () => {
  it('labels a mini GROUP by its surface tag exactly like a scattershot area', () => {
    expect(baseStampLabel(miniGroup('g1', ['m1'], { surface: 'column' }))).toBe('column minis');
    expect(baseStampLabel(area('a1', { surface: 'column' }))).toBe('column minis');
  });

  it('falls back to "bush" when a group or area carries no surface tag', () => {
    expect(baseStampLabel(miniGroup('g1', [], { surface: undefined }))).toBe('bush minis');
  });

  it('labels the other stampable kinds unchanged', () => {
    expect(baseStampLabel(wreath('w1', { sizeIn: 36 }))).toBe('36" wreath');
    expect(baseStampLabel(strand('s1', { bulbType: 'permanent', sideOfHouse: 'left' }))).toBe('left roofline');
    expect(baseStampLabel(strand('s1', { surface: 'railing' }))).toBe('railing wrap');
  });
});

describe('numberStampLabels', () => {
  it('leaves a lone label on a photo unnumbered', () => {
    const items: SceneItem[] = [strand('s1', { surface: 'column' })];
    expect(numbered(items).get('s1')).toBe('column wrap');
  });

  it('numbers duplicate labels in DRAW ORDER (array order) when 2+ share one', () => {
    const items: SceneItem[] = [
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
      strand('s3', { surface: 'column' }),
    ];
    const labels = numbered(items);
    expect(labels.get('s1')).toBe('column wrap 1');
    expect(labels.get('s2')).toBe('column wrap 2');
    expect(labels.get('s3')).toBe('column wrap 3');
  });

  it('scopes numbering PER SOURCE PHOTO — photo 2 numbers 1..3, not 5..7, against photo 1\'s 1..2', () => {
    const items: SceneItem[] = [
      strand('p1-a', { surface: 'column' }), // photo 1 (no photoId)
      strand('p1-b', { surface: 'column' }),
      strand('p2-a', { surface: 'column', photoId: 'extra-1' }),
      strand('p2-b', { surface: 'column', photoId: 'extra-1' }),
      strand('p2-c', { surface: 'column', photoId: 'extra-1' }),
    ];
    const labels = numbered(items);
    expect(labels.get('p1-a')).toBe('column wrap 1');
    expect(labels.get('p1-b')).toBe('column wrap 2');
    expect(labels.get('p2-a')).toBe('column wrap 1');
    expect(labels.get('p2-b')).toBe('column wrap 2');
    expect(labels.get('p2-c')).toBe('column wrap 3');
  });

  it('does not let a different base label on the same photo affect numbering (a lone garland run stays unnumbered)', () => {
    const items: SceneItem[] = [
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
      garland('g1'),
    ];
    const labels = numbered(items);
    expect(labels.get('s1')).toBe('column wrap 1');
    expect(labels.get('s2')).toBe('column wrap 2');
    expect(labels.get('g1')).toBe('garland run');
  });

  it('numbers a mini GROUP alongside plain wrapped items of the same surface (a railing counts as a "column minis" for numbering purposes only when its label matches)', () => {
    // A group's label is "<surface> minis" (matches a miniArea, not a strand
    // wrap), so a group and a bare miniArea on the same surface/photo number
    // together, while a strand wrap (a different base label) does not.
    const items: SceneItem[] = [
      area('a1', { surface: 'column' }),
      miniGroup('g1', ['m1', 'm2'], { surface: 'column' }),
    ];
    const labels = numbered(items);
    expect(labels.get('a1')).toBe('column minis 1');
    expect(labels.get('g1')).toBe('column minis 2');
  });

  it('excludes twins (linkedToId set) from both the count and the map', () => {
    const items: SceneItem[] = [
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
      strand('twin', { surface: 'column', linkedToId: 's1', photoId: 'extra-1' }),
    ];
    const labels = numbered(items);
    expect(labels.get('s1')).toBe('column wrap 1');
    expect(labels.get('s2')).toBe('column wrap 2');
    expect(labels.has('twin')).toBe(false);
  });

  it('is stable across calls for an unchanged scene (same input → same label)', () => {
    const items: SceneItem[] = [
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
    ];
    expect(numbered(items)).toEqual(numbered(items));
  });

  // Coordinator-reported defect, reproduced exactly: a mini GROUP whose
  // members are miniAreas shares its base label ("column minis") with those
  // very members, because baseStampLabel reads a MiniGroupItem and a
  // MiniAreaItem identically. A grouped member can never be shown by name in
  // either consumer (isStampableCanonical excludes it from the twin picker;
  // it only ever appears in the billing-link dropdown as a "Same as"
  // candidate for an UNGROUPED item, never as a row naming itself) — so it
  // must not contribute to the count or receive a number. Before the fix
  // this returned 'column minis 4' (verbatim from the report).
  it('excludes GROUPED MEMBERS from the count — a group does not inherit a number from its own members', () => {
    const items: SceneItem[] = [
      area('m1', { surface: 'column', groupId: 'g1' }),
      area('m2', { surface: 'column', groupId: 'g1' }),
      area('m3', { surface: 'column', groupId: 'g1' }),
      miniGroup('g1', ['m1', 'm2', 'm3'], { surface: 'column' }),
    ];
    const labels = numbered(items);
    expect(labels.get('g1')).toBe('column minis');
    // The members themselves get no entry — neither consumer ever displays
    // one by name, so there is nothing to number them FOR.
    expect(labels.has('m1')).toBe(false);
    expect(labels.has('m2')).toBe(false);
    expect(labels.has('m3')).toBe(false);
  });

  it('mutation-probe companion: two REAL groups sharing a photo and surface still number normally (the fix must not swallow legitimate duplicates)', () => {
    const items: SceneItem[] = [
      area('m1', { surface: 'column', groupId: 'g1' }),
      area('m2', { surface: 'column', groupId: 'g1' }),
      miniGroup('g1', ['m1', 'm2'], { surface: 'column' }),
      area('m3', { surface: 'column', groupId: 'g2' }),
      area('m4', { surface: 'column', groupId: 'g2' }),
      miniGroup('g2', ['m3', 'm4'], { surface: 'column' }),
    ];
    const labels = numbered(items);
    expect(labels.get('g1')).toBe('column minis 1');
    expect(labels.get('g2')).toBe('column minis 2');
    expect(labels.has('m1')).toBe(false);
    expect(labels.has('m2')).toBe(false);
    expect(labels.has('m3')).toBe(false);
    expect(labels.has('m4')).toBe(false);
  });
});

// Fix round item 2a (Jason's ruling): STABLE ordinals — an item's number
// must never change because a sibling was deleted, and gaps are the
// accepted tradeoff.
describe('assignStampOrdinals', () => {
  it('seeds a fresh (back-compat) scene 1..N in draw order, matching what the OLD live-recomputed scheme would have shown', () => {
    const s = scene([
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
      strand('s3', { surface: 'column' }),
    ]);
    const result = assignStampOrdinals(s);
    const byId = new Map(result.items.map((i) => [i.id, (i as StrandItem).stampOrdinal]));
    expect(byId.get('s1')).toBe(1);
    expect(byId.get('s2')).toBe(2);
    expect(byId.get('s3')).toBe(3);
    expect(result.stampOrdinalCounters).toMatchObject({ ' column wrap': 4 });
  });

  it('is idempotent — a second call on an already-assigned scene returns the SAME reference (a true no-op)', () => {
    const once = assignStampOrdinals(scene([strand('s1', { surface: 'column' }), strand('s2', { surface: 'column' })]));
    const twice = assignStampOrdinals(once);
    expect(twice).toBe(once);
  });

  it('an item KEEPS its own ordinal after an EARLIER sibling in the same bucket is deleted — the whole point of the fix', () => {
    const assigned = assignStampOrdinals(scene([
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
      strand('s3', { surface: 'column' }),
    ]));
    // s1 (ordinal 1) is deleted; s2/s3 survive.
    const afterDelete: Scene = { ...assigned, items: assigned.items.filter((i) => i.id !== 's1') };
    const reassigned = assignStampOrdinals(afterDelete); // no-op: s2/s3 already have ordinals
    const s2 = reassigned.items.find((i) => i.id === 's2') as StrandItem;
    const s3 = reassigned.items.find((i) => i.id === 's3') as StrandItem;
    expect(s2.stampOrdinal).toBe(2); // NOT renumbered to 1
    expect(s3.stampOrdinal).toBe(3); // NOT renumbered to 2
    // And the DISPLAYED labels reflect the gap directly.
    const labels = numberStampLabels(reassigned.items);
    expect(labels.get('s2')).toBe('column wrap 2');
    expect(labels.get('s3')).toBe('column wrap 3');
  });

  it('a NEW item never reuses a DELETED sibling\'s number — the counter, not the item count, decides the next one', () => {
    const assigned = assignStampOrdinals(scene([
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
    ]));
    // s2 (ordinal 2) is deleted, leaving only s1 (ordinal 1) — an item-COUNT
    // based scheme would hand the next new item "2" again.
    const afterDelete: Scene = { ...assigned, items: assigned.items.filter((i) => i.id !== 's2') };
    const withNewItem: Scene = { ...afterDelete, items: [...afterDelete.items, strand('s4', { surface: 'column' })] };
    const result = assignStampOrdinals(withNewItem);
    const s4 = result.items.find((i) => i.id === 's4') as StrandItem;
    expect(s4.stampOrdinal).toBe(3); // NOT 2 — that number is retired with s2
  });

  it('a lone SURVIVOR (its bucket shrank to 1) still keeps its persisted ordinal even though it displays unnumbered', () => {
    const assigned = assignStampOrdinals(scene([
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
    ]));
    const afterDelete: Scene = { ...assigned, items: assigned.items.filter((i) => i.id !== 's1') };
    // s2 is now alone in its bucket — displays unnumbered (no longer
    // ambiguous, mirrors pricingEngine's own rule) but its stored ordinal
    // is untouched, so if a sibling reappears later it reads correctly.
    expect(numberStampLabels(afterDelete.items).get('s2')).toBe('column wrap');
    const s2 = afterDelete.items.find((i) => i.id === 's2') as StrandItem;
    expect(s2.stampOrdinal).toBe(2);
  });

  it('defensively advances the counter past a pre-existing ordinal it did not itself assign', () => {
    // Simulates data that already carries a stampOrdinal but no matching
    // counter entry (e.g. hand-edited, or a future import path) — the
    // counter must never hand out a number <= one already in use.
    const s = scene([strand('s1', { surface: 'column', stampOrdinal: 5 })]);
    const result = assignStampOrdinals(s);
    expect(result.stampOrdinalCounters).toMatchObject({ ' column wrap': 6 });
    const s2 = assignStampOrdinals({ ...result, items: [...result.items, strand('s2', { surface: 'column' })] });
    const newItem = s2.items.find((i) => i.id === 's2') as StrandItem;
    expect(newItem.stampOrdinal).toBe(6); // not 1, not 2 — clear of the existing 5
  });

  it('never assigns an ordinal to a twin or a grouped member', () => {
    const s = scene([
      strand('s1', { surface: 'column' }),
      strand('twin', { surface: 'column', linkedToId: 's1' }),
      area('m1', { surface: 'column', groupId: 'g1' }),
      miniGroup('g1', ['m1'], { surface: 'column' }),
    ]);
    const result = assignStampOrdinals(s);
    const twin = result.items.find((i) => i.id === 'twin') as StrandItem;
    const m1 = result.items.find((i) => i.id === 'm1') as MiniAreaItem;
    expect(twin.stampOrdinal).toBeUndefined();
    expect(m1.stampOrdinal).toBeUndefined();
  });
});

// Second fix round HIGH: opening an already-APPROVED (locked) design must
// never attempt a save just because the backfill assigned an ordinal in
// memory — editor.ts's scheduleSave() correctly refuses to PERSIST a
// locked scene, but merely calling it also pops the permanent "your
// changes are NOT saved" banner, and stampOrdinal/stampOrdinalCounters are
// brand-new fields no pre-existing scene has, so EVERY existing approved
// design would backfill (and therefore falsely alarm) on its very first
// render. This is the exact decision editor.ts's stampLabel() delegates to
// — the probe the coordinator asked for.
describe('backfillStampOrdinals', () => {
  it('backfills a LOCKED scene IN MEMORY (the picker still renders correctly) but reports shouldSave: false', () => {
    const before = scene([
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
    ]);
    const result = backfillStampOrdinals(before, /* locked */ true);

    // No save should be scheduled for a locked scene — simulated here by
    // asserting the CALLER'S contract (shouldSave) rather than a real
    // scheduleSave(), since editor.ts itself can't be imported in this
    // test environment (it needs Konva's Node canvas binding).
    expect(result.shouldSave).toBe(false);

    // The picker must still render correctly: both items get real,
    // correctly-numbered labels, backfilled in memory even though nothing
    // will be persisted.
    const labels = numberStampLabels(result.scene.items);
    expect(labels.get('s1')).toBe('column wrap 1');
    expect(labels.get('s2')).toBe('column wrap 2');
  });

  it('schedules a save for the identical UNLOCKED scene (unchanged prior behavior)', () => {
    const before = scene([
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
    ]);
    const result = backfillStampOrdinals(before, /* locked */ false);
    expect(result.shouldSave).toBe(true);
    const labels = numberStampLabels(result.scene.items);
    expect(labels.get('s1')).toBe('column wrap 1');
    expect(labels.get('s2')).toBe('column wrap 2');
  });

  it('never schedules a save for a locked scene that needed NO backfill either (nothing changed, nothing to save)', () => {
    const already = assignStampOrdinals(scene([strand('s1', { surface: 'column' })]));
    const result = backfillStampOrdinals(already, /* locked */ true);
    expect(result.shouldSave).toBe(false);
    expect(result.scene).toBe(already); // same reference — a true no-op
  });
});

// Second fix round MEDIUM: editor.ts's pruneOrphanedMiniGroupsNotify toast
// wrapper used to diff isMiniGroup items only, so a dangling SINGLE-ITEM
// twin (item 1's fix taught pruneOrphanedMiniGroups to remove one of THOSE
// too) was removed with zero staff notification.
describe('describePrunedItems', () => {
  it('describes a dangling SINGLE-ITEM twin (not a group) — the exact gap the old isMiniGroup-only diff missed', () => {
    const before: SceneItem[] = [
      wreath('dangling-twin', { linkedToId: 'dead-canonical', sizeIn: 36 }),
      strand('healthy', { surface: 'column' }),
    ];
    const after = pruneOrphanedMiniGroups(before);
    const notices = describePrunedItems(before, after);
    expect(notices).toEqual([{ reason: 'linked-copy-gone', item: before[0] }]);
  });

  it('describes a dangling TWIN GROUP the same way as a single item', () => {
    const before: SceneItem[] = [
      area('tm1', { groupId: 'twin-g', surface: 'column' }),
      miniGroup('twin-g', ['tm1'], { linkedToId: 'dead-canonical-group', surface: 'column' }),
    ];
    const after = pruneOrphanedMiniGroups(before);
    const notices = describePrunedItems(before, after);
    expect(notices).toEqual([{ reason: 'linked-copy-gone', item: before[1] }]);
  });

  it('describes a miniGroup that lost all its members (#227) as "empty-group", unrelated to any twin', () => {
    const before: SceneItem[] = [
      miniGroup('g1', ['dead-1', 'dead-2'], { surface: 'railing', stringCount: 8 }),
    ];
    const after = pruneOrphanedMiniGroups(before);
    const notices = describePrunedItems(before, after);
    expect(notices).toEqual([{ reason: 'empty-group', item: before[0] }]);
  });

  it('reports nothing for an item that survives the prune', () => {
    const before: SceneItem[] = [strand('s1', { surface: 'column' })];
    const after = pruneOrphanedMiniGroups(before);
    expect(describePrunedItems(before, after)).toEqual([]);
  });

  it('reports both a dangling twin AND an unrelated empty group when both are pruned in the same edit', () => {
    const before: SceneItem[] = [
      wreath('dangling-twin', { linkedToId: 'dead-canonical' }),
      miniGroup('g1', ['dead-1'], { surface: 'railing', stringCount: 4 }),
    ];
    const after = pruneOrphanedMiniGroups(before);
    const notices = describePrunedItems(before, after);
    expect(notices).toHaveLength(2);
    expect(notices).toEqual(
      expect.arrayContaining([
        { reason: 'linked-copy-gone', item: before[0] },
        { reason: 'empty-group', item: before[1] },
      ]),
    );
  });
});
