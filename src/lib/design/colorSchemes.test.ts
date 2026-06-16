import { describe, it, expect } from 'vitest';
import {
  COLOR_SCHEMES,
  DEFAULT_COLOR_SCHEME_ID,
  getColorScheme,
  resolveSchemeColorIds,
} from './colorSchemes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

const PALETTE_IDS = new Set(DEFAULT_COLORS.map((c) => c.id));

describe('color schemes', () => {
  it('has the "as designed" default with a null (no-override) color list', () => {
    const def = getColorScheme(DEFAULT_COLOR_SCHEME_ID);
    expect(def.id).toBe('as-designed');
    expect(def.colorIds).toBeNull();
  });

  it('has unique scheme ids', () => {
    const ids = COLOR_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references real palette color ids', () => {
    for (const scheme of COLOR_SCHEMES) {
      if (scheme.colorIds === null) continue;
      expect(scheme.colorIds.length).toBeGreaterThan(0);
      for (const cid of scheme.colorIds) {
        expect(PALETTE_IDS.has(cid)).toBe(true);
      }
    }
  });

  it('resolves a known pattern scheme to its color-id list', () => {
    expect(resolveSchemeColorIds('warm-white')).toEqual(['warm-white']);
    expect(resolveSchemeColorIds('champagne')).toEqual(['warm-white', 'cool-white']);
    expect(resolveSchemeColorIds('candy-cane')).toEqual(['cool-white', 'red', 'red']);
  });

  it('resolves "as designed" and unknown / missing ids to null (no override)', () => {
    expect(resolveSchemeColorIds('as-designed')).toBeNull();
    expect(resolveSchemeColorIds('not-a-scheme')).toBeNull();
    expect(resolveSchemeColorIds(undefined)).toBeNull();
    expect(resolveSchemeColorIds(null)).toBeNull();
  });

  it('falls back to the default scheme record for unknown ids', () => {
    expect(getColorScheme('nope').id).toBe(DEFAULT_COLOR_SCHEME_ID);
  });
});
