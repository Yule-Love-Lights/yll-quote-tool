import { describe, it, expect } from 'vitest';
import { exampleToFewShot, type TrainingExampleRow } from './trainingExamples';
import { editableItems, applyItemCorrections } from './design/sceneCorrections';
import type { Scene } from './design/sceneTypes';

// A minimal scene: one tagged front-roofline C9 strand across a 1000×500 photo.
const SCENE: Scene = {
  yardsticks: [],
  items: [
    {
      id: 'seed-santas-1', yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [100, 100, 600, 100],
      surface: 'santas-roofline', included: true,
    },
  ],
};

function row(overrides: Partial<TrainingExampleRow> = {}): TrainingExampleRow {
  return {
    id: 'ex-1', created_at: '2026-06-12T00:00:00Z', quote_id: 'q1', design_id: 'd1',
    source: 'manual', excluded: false, notes: null, address: '1 Main',
    street_photo_base64: 'AAAA', street_media_type: 'image/jpeg', street_w: 1000, street_h: 500,
    satellite_base64: null, satellite_media_type: null, satellite_w: null, satellite_h: null,
    satellite_feet_per_pixel: null, satellite_lines: null,
    original_analysis: null,
    final_scene: SCENE,
    final_inputs: { santasFootage: 50, santasDifficulty: 'medium', gingerbreadFootage: 0, gingerbreadDifficulty: 'medium' },
    ...overrides,
  };
}

describe('exampleToFewShot', () => {
  it('M1: returns null when the street photo is missing', () => {
    expect(exampleToFewShot(row({ street_photo_base64: null }))).toBeNull();
  });

  it('M1: returns null when street pixel dims are missing/zero (would teach empty lines vs nonzero footage)', () => {
    expect(exampleToFewShot(row({ street_w: 0 }))).toBeNull();
    expect(exampleToFewShot(row({ street_h: null }))).toBeNull();
  });

  it('projects the final scene roofline into normalized polylines', () => {
    const ex = exampleToFewShot(row())!;
    expect(ex).not.toBeNull();
    expect(ex.source).toBe('design');
    expect(ex.photos).toHaveLength(1); // street only
    expect(ex.santasLines).toHaveLength(1);
    expect(ex.santasLines[0].points).toEqual([[0.1, 0.2], [0.6, 0.2]]);
    expect(ex.santasFootage).toBe(50);
  });

  it('M2: a satellite image WITHOUT confirmed lines is NOT taught (no incoherent empty-arrays lesson)', () => {
    const ex = exampleToFewShot(row({
      satellite_base64: 'SAT', satellite_media_type: 'image/jpeg',
      satellite_lines: { santas: [], gingerbread: [], c9: [] },
    }))!;
    expect(ex.photos).toHaveLength(1); // satellite dropped
    expect(ex.photos.every((p) => p.tag !== 'satellite')).toBe(true);
    expect(ex.satelliteSantasLines).toEqual([]);
  });

  it('M2: a satellite image WITH confirmed lines rides along, lines included', () => {
    const ex = exampleToFewShot(row({
      satellite_base64: 'SAT', satellite_media_type: 'image/jpeg', satellite_feet_per_pixel: 0.15,
      satellite_lines: {
        santas: [{ points: [[0.2, 0.5], [0.7, 0.5]], label: 'front' }],
        gingerbread: [], c9: [], santasFootage: 50,
      },
    }))!;
    expect(ex.photos).toHaveLength(2);
    expect(ex.photos[1].tag).toBe('satellite');
    expect(ex.satelliteSantasLines).toHaveLength(1);
    expect(ex.satelliteSantasFootage).toBe(50);
  });
});

// #52 — inline edit of a saved example: enumerate + correct detections (mini
// strand counts, spritzer/wreath size, wreath/garland tier, garland length).
const MIXED: Scene = {
  yardsticks: [],
  items: [
    { id: 'bush-1', yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6, drawingStyle: 'strand', colorPattern: ['warm-white'], points: [10, 10, 50, 10], surface: 'bush', stringCount: 2 },
    { id: 'tree-1', yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6, drawingStyle: 'strand', colorPattern: ['warm-white'], points: [60, 10, 60, 80], surface: 'tree', stringCount: 4, wrapStyle: 'trunk' },
    { id: 'col-1', yardstickId: null, kind: 'miniArea', shape: 'box', x: 100, y: 100, width: 20, height: 60, surface: 'column', stringCount: 3 },
    // grouped mini (railing member) — skipped by the few-shot, so NOT editable
    { id: 'grp-member-1', yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6, drawingStyle: 'strand', colorPattern: ['warm-white'], points: [200, 10, 240, 10], surface: 'bush', stringCount: 5, groupId: 'grp-1' },
    // c9 roofline strand — not a mini
    { id: 'c9-1', yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12, drawingStyle: 'strand', colorPattern: ['warm-white'], points: [0, 0, 100, 0], surface: 'santas-roofline' },
    { id: 'sp-1', yardstickId: null, kind: 'spritzer', x: 300, y: 300, sizeIn: 24, colorPattern: ['warm-white'], quoteSize: '16' },
    { id: 'wr-1', yardstickId: null, kind: 'wreath', x: 400, y: 100, sizeIn: 36, withLights: true, quoteSize: '36noble', tier: 'bow' },
    { id: 'gr-1', yardstickId: null, kind: 'garland', points: [500, 50, 600, 50], drawingStyle: 'strand', withLights: true, quoteLength: '9ft', tier: 'fullDecor' },
    // grouped railing — the GROUP holds the billed count (edit the group, not members)
    { id: 'rail-grp-1', yardstickId: null, kind: 'miniGroup', surface: 'railing', stringCount: 6, memberIds: ['grp-member-1'] },
    // a standalone (ungrouped) curtain strand
    { id: 'curtain-1', yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6, drawingStyle: 'strand', colorPattern: ['warm-white'], points: [700, 10, 740, 10], surface: 'curtain', stringCount: 4 },
  ],
};

const byIdOf = (s: Scene) => Object.fromEntries(s.items.map((i) => [i.id, i])) as Record<string, Record<string, unknown>>;

describe('editableItems (#52)', () => {
  it('lists minis (bush/tree/column + railing group + curtain) + spritzer/wreath/garland; excludes grouped MEMBERS + c9', () => {
    const items = editableItems(MIXED);
    expect(items.map((i) => i.id)).toEqual(['bush-1', 'tree-1', 'col-1', 'sp-1', 'wr-1', 'gr-1', 'rail-grp-1', 'curtain-1']);
    expect(items.find((i) => i.id === 'bush-1')).toMatchObject({ kind: 'mini', surface: 'bush', stringCount: 2 });
    // the railing GROUP is editable (its count), its member strand is not
    expect(items.find((i) => i.id === 'rail-grp-1')).toMatchObject({ kind: 'mini', surface: 'railing', stringCount: 6 });
    expect(items.find((i) => i.id === 'grp-member-1')).toBeUndefined();
    expect(items.find((i) => i.id === 'curtain-1')).toMatchObject({ kind: 'mini', surface: 'curtain', stringCount: 4 });
    expect(items.find((i) => i.id === 'sp-1')).toMatchObject({ kind: 'spritzer', quoteSize: '16' });
    expect(items.find((i) => i.id === 'wr-1')).toMatchObject({ kind: 'wreath', quoteSize: '36noble', tier: 'bow' });
    expect(items.find((i) => i.id === 'gr-1')).toMatchObject({ kind: 'garland', quoteLength: '9ft', tier: 'fullDecor' });
  });
});

describe('applyItemCorrections (#52)', () => {
  it('corrects a mini strand count, preserving everything else', () => {
    const b = byIdOf(applyItemCorrections(MIXED, { 'bush-1': { stringCount: 3 } }));
    expect(b['bush-1'].stringCount).toBe(3); // 2 → 3
    expect(b['tree-1'].stringCount).toBe(4); // untouched
  });

  it('corrects a grouped railing count + a standalone curtain count', () => {
    const b = byIdOf(applyItemCorrections(MIXED, { 'rail-grp-1': { stringCount: 8 }, 'curtain-1': { stringCount: 2 } }));
    expect(b['rail-grp-1'].stringCount).toBe(8); // group count 6 → 8
    expect(b['curtain-1'].stringCount).toBe(2); // curtain 4 → 2
  });

  it('changes spritzer + wreath size and wreath/garland tier', () => {
    const b = byIdOf(applyItemCorrections(MIXED, {
      'sp-1': { quoteSize: '32' },
      'wr-1': { quoteSize: '48noble', tier: 'fullDecor' },
      'gr-1': { quoteLength: '4.5ft', tier: 'bow' },
    }));
    expect(b['sp-1'].quoteSize).toBe('32');
    expect(b['wr-1']).toMatchObject({ quoteSize: '48noble', tier: 'fullDecor' });
    expect(b['gr-1']).toMatchObject({ quoteLength: '4.5ft', tier: 'bow' });
  });

  it('ignores values invalid for the item kind', () => {
    const b = byIdOf(applyItemCorrections(MIXED, {
      'sp-1': { quoteSize: '36noble' }, // a wreath size on a spritzer → rejected
      'wr-1': { quoteSize: '16', tier: 'nope' }, // spritzer size + bad tier → both rejected
    }));
    expect(b['sp-1'].quoteSize).toBe('16'); // unchanged
    expect(b['wr-1']).toMatchObject({ quoteSize: '36noble', tier: 'bow' }); // unchanged
  });

  it('ignores non-editable ids (grouped mini, c9, unknown) and clamps counts', () => {
    const b = byIdOf(applyItemCorrections(MIXED, {
      'grp-member-1': { stringCount: 9 },
      'c9-1': { stringCount: 9 },
      'nope': { stringCount: 9 },
      'bush-1': { stringCount: 0 }, // clamps to 1
      'tree-1': { stringCount: 3.6 }, // rounds to 4
    }));
    expect(b['grp-member-1'].stringCount).toBe(5); // grouped → unchanged
    expect(b['bush-1'].stringCount).toBe(1);
    expect(b['tree-1'].stringCount).toBe(4);
  });

  it('does not mutate the input scene', () => {
    const before = JSON.parse(JSON.stringify(MIXED));
    applyItemCorrections(MIXED, { 'bush-1': { stringCount: 7 }, 'sp-1': { quoteSize: '32' } });
    expect(MIXED).toEqual(before);
  });
});
