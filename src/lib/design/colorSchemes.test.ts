import { describe, it, expect } from 'vitest';
import {
  COLOR_SCHEMES,
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  getColorScheme,
  resolveSchemeColorIds,
  BUILDABLE_COLOR_IDS,
  MAX_CUSTOM_PATTERN,
  sanitizeCustomPattern,
  isKnownColorSchemeId,
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

describe('build-your-own custom pattern (#49)', () => {
  it('buildable colors are real palette ids and exclude black', () => {
    expect(BUILDABLE_COLOR_IDS.length).toBeGreaterThan(0);
    expect(BUILDABLE_COLOR_IDS).not.toContain('black');
    for (const id of BUILDABLE_COLOR_IDS) expect(PALETTE_IDS.has(id)).toBe(true);
  });

  it('sanitizes to valid buildable ids in order, dropping junk', () => {
    expect(sanitizeCustomPattern(['red', 'cool-white', 'red'])).toEqual(['red', 'cool-white', 'red']);
    expect(sanitizeCustomPattern(['red', 'nope', 'black', 42, null, 'blue'])).toEqual(['red', 'blue']);
  });

  it('returns [] for non-array / empty input', () => {
    expect(sanitizeCustomPattern(null)).toEqual([]);
    expect(sanitizeCustomPattern('red')).toEqual([]);
    expect(sanitizeCustomPattern(undefined)).toEqual([]);
    expect(sanitizeCustomPattern([])).toEqual([]);
  });

  it('caps at MAX_CUSTOM_PATTERN', () => {
    const long = Array.from({ length: MAX_CUSTOM_PATTERN + 5 }, () => 'red');
    expect(sanitizeCustomPattern(long)).toHaveLength(MAX_CUSTOM_PATTERN);
  });

  it('isKnownColorSchemeId accepts presets + custom, rejects junk', () => {
    expect(isKnownColorSchemeId(DEFAULT_COLOR_SCHEME_ID)).toBe(true);
    expect(isKnownColorSchemeId(CUSTOM_SCHEME_ID)).toBe(true);
    for (const s of COLOR_SCHEMES) expect(isKnownColorSchemeId(s.id)).toBe(true);
    expect(isKnownColorSchemeId('foo-bar')).toBe(false);
    expect(isKnownColorSchemeId('')).toBe(false);
    expect(isKnownColorSchemeId(null)).toBe(false);
    expect(isKnownColorSchemeId(42)).toBe(false);
  });
});
