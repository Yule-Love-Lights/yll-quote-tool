import { describe, expect, it } from 'vitest';
import { itemThumbnailBBox } from './stampThumbnails';
import type { MiniAreaItem, MiniGroupItem, SceneItem, StrandItem, WreathItem } from './sceneTypes';

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
    ...over,
  };
}

function group(id: string, memberIds: string[], over: Partial<MiniGroupItem> = {}): MiniGroupItem {
  return { id, yardstickId: null, kind: 'miniGroup', memberIds, surface: 'column', ...over };
}

function wreath(id: string, over: Partial<WreathItem> = {}): WreathItem {
  return { id, yardstickId: null, kind: 'wreath', x: 100, y: 200, sizeIn: 36, withLights: true, ...over };
}

describe('itemThumbnailBBox', () => {
  it('pads a box-shaped miniArea by its own dimensions', () => {
    const box = itemThumbnailBBox(area('a1'));
    expect(box).toEqual({ x: 2, y: 12, w: 66, h: 76 }); // 10-8, 20-8, 50+16, 60+16
  });

  it('bounds + pads a strand\'s points', () => {
    const box = itemThumbnailBBox(strand('s1', { points: [0, 0, 100, 50] }));
    expect(box).toEqual({ x: -24, y: -24, w: 148, h: 98 }); // bounds (0,0)-(100,50) padded 24
  });

  it('centers a point-anchored item (wreath/bow/spritzer) on its own (x,y)', () => {
    const box = itemThumbnailBBox(wreath('w1'));
    expect(box).toEqual({ x: 40, y: 140, w: 120, h: 120 });
  });

  it('returns null for a polygon miniArea with no points', () => {
    const box = itemThumbnailBBox(area('a1', { shape: 'polygon', points: undefined }));
    expect(box).toBeNull();
  });

  it('bounds + pads a polygon miniArea\'s points', () => {
    const box = itemThumbnailBBox(area('a1', { shape: 'polygon', points: [0, 0, 40, 0, 40, 40, 0, 40] }));
    expect(box).toEqual({ x: -24, y: -24, w: 88, h: 88 });
  });

  it('unions the live members\' boxes for a miniGroup', () => {
    const items: SceneItem[] = [
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0] }),
      strand('m2', { groupId: 'g1', points: [100, 100, 120, 100] }),
      group('g1', ['m1', 'm2']),
    ];
    const g1 = items[2] as MiniGroupItem;
    const box = itemThumbnailBBox(g1, items);
    // m1 padded: x -24..44, y -24..24. m2 padded: x 76..144, y 76..124.
    // Union: x -24..144 (w 168), y -24..124 (h 148).
    expect(box).toEqual({ x: -24, y: -24, w: 168, h: 148 });
  });

  it('excludes a member whose groupId no longer matches (a stale backref)', () => {
    const items: SceneItem[] = [
      strand('m1', { groupId: 'g1', points: [0, 0, 20, 0] }),
      strand('stale', { groupId: 'g2', points: [1000, 1000, 1020, 1000] }),
      group('g1', ['m1', 'stale']),
    ];
    const g1 = items[2] as MiniGroupItem;
    const box = itemThumbnailBBox(g1, items);
    // Only m1 contributes — the union must NOT be dragged out to 'stale's
    // far-away coordinates.
    expect(box).toEqual({ x: -24, y: -24, w: 68, h: 48 });
  });

  it('returns null for a miniGroup with zero live members', () => {
    const items: SceneItem[] = [group('g1', ['dead-1', 'dead-2'])];
    const box = itemThumbnailBBox(items[0] as MiniGroupItem, items);
    expect(box).toBeNull();
  });

  it('returns null for a kind with no drawable geometry (text/custom/pole)', () => {
    const textItem: SceneItem = { id: 't1', yardstickId: null, kind: 'text', x: 0, y: 0, text: 'hi', fontFamily: 'Arial', sizeIn: 12, colorId: 'red' };
    expect(itemThumbnailBBox(textItem)).toBeNull();
  });
});
