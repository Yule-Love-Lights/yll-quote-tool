import { describe, expect, it } from 'vitest';
import { baseStampLabel, numberStampLabels } from './stampLabels';
import type { GarlandItem, MiniAreaItem, MiniGroupItem, SceneItem, StrandItem, WreathItem } from './sceneTypes';

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
    expect(numberStampLabels(items).get('s1')).toBe('column wrap');
  });

  it('numbers duplicate labels in DRAW ORDER (array order) when 2+ share one', () => {
    const items: SceneItem[] = [
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
      strand('s3', { surface: 'column' }),
    ];
    const labels = numberStampLabels(items);
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
    const labels = numberStampLabels(items);
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
    const labels = numberStampLabels(items);
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
    const labels = numberStampLabels(items);
    expect(labels.get('a1')).toBe('column minis 1');
    expect(labels.get('g1')).toBe('column minis 2');
  });

  it('excludes twins (linkedToId set) from both the count and the map', () => {
    const items: SceneItem[] = [
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
      strand('twin', { surface: 'column', linkedToId: 's1', photoId: 'extra-1' }),
    ];
    const labels = numberStampLabels(items);
    expect(labels.get('s1')).toBe('column wrap 1');
    expect(labels.get('s2')).toBe('column wrap 2');
    expect(labels.has('twin')).toBe(false);
  });

  it('is stable across calls for an unchanged scene (same input → same label)', () => {
    const items: SceneItem[] = [
      strand('s1', { surface: 'column' }),
      strand('s2', { surface: 'column' }),
    ];
    expect(numberStampLabels(items)).toEqual(numberStampLabels(items));
  });
});
