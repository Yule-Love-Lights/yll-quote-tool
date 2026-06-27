// src/lib/inventory/concepts.test.ts
import { describe, it, expect } from 'vitest';
import {
  bulbKey, wreathKey, garlandKey, spritzerKey, miniKey,
  bulbRows, wreathRows, garlandRows, miniRows, spritzerRows,
  CLIP_FEATURES,
} from './concepts';

describe('concept key builders', () => {
  it('builds namespaced keys', () => {
    expect(bulbKey('warm-white', 'c9')).toBe('bulb:warm-white:c9');
    expect(wreathKey('24noble', 'fullDecor')).toBe('wreath:24noble:fullDecor');
    expect(garlandKey('9ft', 'bow')).toBe('garland:9ft:bow');
    expect(spritzerKey('24')).toBe('spritzer:24');
    expect(miniKey('tree', 'canopy')).toBe('mini:tree:canopy');
  });
});

describe('concept row generators', () => {
  it('produces the full cartesian set per group', () => {
    expect(bulbRows()).toHaveLength(48); // 12 colors × 4 bulb types
    expect(wreathRows()).toHaveLength(12); // 6 sizes × 2 tiers
    expect(garlandRows()).toHaveLength(4); // 2 lengths × 2 tiers
    expect(miniRows()).toHaveLength(8); // 4 surfaces × 2 wraps
    expect(spritzerRows()).toHaveLength(3); // 3 sizes
    expect(CLIP_FEATURES).toHaveLength(7);
  });

  it('rows carry the right key + a human label', () => {
    const warmC9 = bulbRows().find((r) => r.key === 'bulb:warm-white:c9');
    expect(warmC9?.label).toBe('Warm White');
    const w = wreathRows().find((r) => r.key === 'wreath:24noble:bow');
    expect(w?.label).toContain('24');
    const s = spritzerRows()[0];
    expect(s.fields.map((f) => f.id)).toEqual(['spritzerSku', 'stakeMetalSku']);
  });
});
