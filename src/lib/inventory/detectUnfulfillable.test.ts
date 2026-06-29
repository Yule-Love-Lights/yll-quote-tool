import { describe, it, expect } from 'vitest';
import type { SceneItem, QuoteSpritzerSize } from '@/lib/design/sceneTypes';
import { detectUnfulfillable } from './detectUnfulfillable';
import type { OfferedColors } from './resolveInstalls';

const sp = (id: string, colors: string[], size: QuoteSpritzerSize = '24'): SceneItem =>
  ({ kind: 'spritzer', id, x: 0, y: 0, sizeIn: 24, colorPattern: colors, quoteSize: size, yardstickId: null }) as unknown as SceneItem;
const mini = (id: string, colors: string[], surface = 'bush'): SceneItem =>
  ({ kind: 'strand', id, surface, colorPattern: colors, stringCount: 1, points: [0, 0, 1, 1], bulbType: 'mini', spacingIn: 6, drawingStyle: 'solid', yardstickId: null }) as unknown as SceneItem;

// minis offer all palette colors; spritzers offer only 6 (no orange/yellow/purple/teal).
const SPRITZER_24 = ['warm-white', 'cool-white', 'red', 'green', 'blue', 'pink'];
const offered: OfferedColors = {
  miniHas: (id) => id !== 'black',
  spritzerHas: (id, size) => size === '24' && SPRITZER_24.includes(id),
};

const ids = (items: SceneItem[]) => detectUnfulfillable(items, offered).map((u) => u.sceneItemId);

describe('detectUnfulfillable', () => {
  it('flags a single color we do not offer for the type (orange spritzer)', () => {
    expect(ids([sp('s1', ['orange'])])).toEqual(['s1']);
  });

  it('passes a single offered color', () => {
    expect(ids([sp('s1', ['blue']), mini('m1', ['orange'])])).toEqual([]); // orange IS offered for minis
  });

  it('passes an empty color pattern (defaults to warm-white, which is offered)', () => {
    expect(ids([sp('s1', [])])).toEqual([]);
  });

  it('flags a single item drawn multi-color with no stocked strand (red+blue+pink)', () => {
    expect(ids([sp('s1', ['red', 'blue', 'pink'])])).toEqual(['s1']);
    expect(ids([mini('m1', ['red', 'blue', 'pink'])])).toEqual(['m1']);
  });

  it('passes a multi-color item that matches a stocked strand for its product', () => {
    expect(ids([sp('s1', ['green', 'red'])])).toEqual([]); // Christmas spritzer strand exists
    expect(ids([mini('m1', ['red', 'green', 'cool-white'])])).toEqual([]); // Grinch mini strand
  });

  it('flags a multi-color SPRITZER whose pattern has a mini strand but NO spritzer strand (Ocean)', () => {
    // Ocean has a mini strand but no spritzer strand → a single Ocean spritzer can't be built.
    expect(ids([sp('s1', ['teal', 'blue', 'cool-white'])])).toEqual(['s1']);
    // ...but the same Ocean colors on a bush are fine (Ocean mini strand exists).
    expect(ids([mini('m1', ['teal', 'blue', 'cool-white'])])).toEqual([]);
  });

  it('includes the offered list in the single-color message', () => {
    const [u] = detectUnfulfillable([sp('s1', ['orange'])], offered);
    expect(u.message).toContain("We don't offer Orange spritzers");
    expect(u.message).toContain('offered:');
  });
});
