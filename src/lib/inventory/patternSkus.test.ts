import { describe, it, expect } from 'vitest';
import { PATTERN_SKUS, matchPattern, colorSetKey } from './patternSkus';
import { MINI_LIGHTS, SPRITZERS } from './concepts';

const MINI_SKUS = new Set(MINI_LIGHTS.map((m) => m.sku));
const SPRITZER_BY_SIZE = SPRITZERS.reduce<Record<string, Set<string>>>((acc, s) => {
  (acc[s.size] ??= new Set()).add(s.sku);
  return acc;
}, {});

describe('PATTERN_SKUS catalog integrity', () => {
  it('every mini strand SKU exists in MINI_LIGHTS', () => {
    for (const p of PATTERN_SKUS) {
      expect(MINI_SKUS.has(p.miniSku), `${p.id} mini ${p.miniSku}`).toBe(true);
    }
  });

  it('every spritzer strand SKU exists in SPRITZERS at its declared size', () => {
    for (const p of PATTERN_SKUS) {
      for (const [size, sku] of Object.entries(p.spritzerSku ?? {})) {
        expect(SPRITZER_BY_SIZE[size]?.has(sku), `${p.id} spritzer ${size}" ${sku}`).toBe(true);
      }
    }
  });

  it('spritzer pattern strands are 16"/24" only (never 32")', () => {
    for (const p of PATTERN_SKUS) {
      expect(p.spritzerSku?.['32'], `${p.id} should have no 32" strand`).toBeUndefined();
    }
  });

  it('every pattern color set is unique (no two patterns collide)', () => {
    const keys = PATTERN_SKUS.map((p) => colorSetKey(p.colorSet));
    expect(new Set(keys).size).toBe(PATTERN_SKUS.length);
  });
});

describe('matchPattern', () => {
  it('matches by color SET, order-ignored', () => {
    expect(matchPattern(['green', 'red'])?.id).toBe('christmas');
    expect(matchPattern(['red', 'green'])?.id).toBe('christmas');
    expect(matchPattern(['cool-white', 'blue', 'teal'])?.id).toBe('ocean');
  });

  it('ignores duplicates in the input', () => {
    expect(matchPattern(['red', 'green', 'green', 'cool-white'])?.id).toBe('grinch');
  });

  it('a single color (or none) is never a pattern', () => {
    expect(matchPattern(['red'])).toBeNull();
    expect(matchPattern(['red', 'red'])).toBeNull();
    expect(matchPattern([])).toBeNull();
  });

  it('an unknown multi-color combo is not a pattern', () => {
    expect(matchPattern(['red', 'blue', 'pink'])).toBeNull();
    expect(matchPattern(['orange', 'yellow'])).toBeNull();
  });
});
