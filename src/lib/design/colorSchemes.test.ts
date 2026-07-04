import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COLOR_SCHEMES,
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  getColorScheme,
  resolveSchemeColorIds,
  DEFAULT_BUILDABLE_COLOR_IDS,
  MAX_CUSTOM_PATTERN,
  sanitizeCustomPattern,
  isKnownColorSchemeId,
  PERMANENT_COLOR_SCHEMES,
  isPermanentColorSchemeId,
  type ColorScheme,
} from './colorSchemes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

const PALETTE_IDS = new Set(DEFAULT_COLORS.map((c) => c.id));

// A tiny operator-configured list (#101): renamed label, reordered, one custom
// preset composed from palette colors, and a built-in dropped (no 'champagne').
const CUSTOM_LIST: ColorScheme[] = [
  { id: 'as-designed', label: "Our team's look", colorIds: null },
  { id: 'red-gold', label: 'Red & Gold', colorIds: ['red', 'yellow'] },
  { id: 'warm-white', label: 'Warm White', colorIds: ['warm-white'] },
];

describe('color schemes', () => {
  it('has the "as designed" default with a null (no-override) color list', () => {
    const def = getColorScheme(DEFAULT_COLOR_SCHEME_ID);
    expect(def.id).toBe('as-designed');
    expect(def.colorIds).toBeNull();
  });

  it('has unique scheme ids', () => {
    const ids = DEFAULT_COLOR_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references real palette color ids', () => {
    for (const scheme of DEFAULT_COLOR_SCHEMES) {
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

  it('resolves against an explicit (operator-configured) scheme list (#101)', () => {
    expect(resolveSchemeColorIds('red-gold', CUSTOM_LIST)).toEqual(['red', 'yellow']);
    // a built-in the operator dropped is unknown in their list → as-designed (null)
    expect(resolveSchemeColorIds('champagne', CUSTOM_LIST)).toBeNull();
    expect(getColorScheme('warm-white', CUSTOM_LIST).label).toBe('Warm White');
  });
});

describe('build-your-own custom pattern (#49)', () => {
  it('buildable colors are real palette ids and exclude black', () => {
    expect(DEFAULT_BUILDABLE_COLOR_IDS.length).toBeGreaterThan(0);
    expect(DEFAULT_BUILDABLE_COLOR_IDS).not.toContain('black');
    for (const id of DEFAULT_BUILDABLE_COLOR_IDS) expect(PALETTE_IDS.has(id)).toBe(true);
  });

  it('sanitizes to valid buildable ids in order, dropping junk', () => {
    expect(sanitizeCustomPattern(['red', 'cool-white', 'red'])).toEqual(['red', 'cool-white', 'red']);
    expect(sanitizeCustomPattern(['red', 'nope', 'black', 42, null, 'blue'])).toEqual(['red', 'blue']);
  });

  it('sanitizes against an explicit (operator-curated) buildable list (#101)', () => {
    // only red + blue offered → green is dropped even though it's a real color
    expect(sanitizeCustomPattern(['red', 'green', 'blue'], ['red', 'blue'])).toEqual(['red', 'blue']);
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
    for (const s of DEFAULT_COLOR_SCHEMES) expect(isKnownColorSchemeId(s.id)).toBe(true);
    expect(isKnownColorSchemeId('foo-bar')).toBe(false);
    expect(isKnownColorSchemeId('')).toBe(false);
    expect(isKnownColorSchemeId(null)).toBe(false);
    expect(isKnownColorSchemeId(42)).toBe(false);
  });

  it('isKnownColorSchemeId validates against an explicit list (#101)', () => {
    expect(isKnownColorSchemeId('red-gold', CUSTOM_LIST)).toBe(true);
    expect(isKnownColorSchemeId(CUSTOM_SCHEME_ID, CUSTOM_LIST)).toBe(true); // 'custom' always allowed
    expect(isKnownColorSchemeId('champagne', CUSTOM_LIST)).toBe(false); // dropped by the operator
  });
});

describe('permanent lighting picker (#88 P6b-2)', () => {
  it('offers warm-white + as-designed + a couple color scenes, all real palette ids', () => {
    const ids = PERMANENT_COLOR_SCHEMES.map((s) => s.id);
    expect(ids).toContain('as-designed'); // the default the provider opens on
    expect(ids).toContain('warm-white');  // the nightly everyday look
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(ids).not.toContain(CUSTOM_SCHEME_ID); // no build-your-own for permanent
    for (const s of PERMANENT_COLOR_SCHEMES) {
      if (s.colorIds === null) continue;
      expect(s.colorIds.length).toBeGreaterThan(0);
      for (const cid of s.colorIds) expect(PALETTE_IDS.has(cid)).toBe(true);
    }
  });

  it('as-designed is first so the vibrant designed look is the default preview', () => {
    expect(PERMANENT_COLOR_SCHEMES[0]!.id).toBe('as-designed');
  });

  it('isPermanentColorSchemeId accepts only the fixed permanent set — not custom, not holiday-only schemes', () => {
    for (const s of PERMANENT_COLOR_SCHEMES) expect(isPermanentColorSchemeId(s.id)).toBe(true);
    expect(isPermanentColorSchemeId(CUSTOM_SCHEME_ID)).toBe(false); // no custom for permanent
    expect(isPermanentColorSchemeId('candy-cane')).toBe(false); // a holiday-only scheme
    expect(isPermanentColorSchemeId('christmas')).toBe(false);
    expect(isPermanentColorSchemeId('')).toBe(false);
    expect(isPermanentColorSchemeId(null)).toBe(false);
    expect(isPermanentColorSchemeId(42)).toBe(false);
  });

  it('every permanent scheme resolves against its own list (independent of operator swatch curation)', () => {
    expect(resolveSchemeColorIds('warm-white', PERMANENT_COLOR_SCHEMES)).toEqual(['warm-white']);
    expect(resolveSchemeColorIds('as-designed', PERMANENT_COLOR_SCHEMES)).toBeNull();
    expect(resolveSchemeColorIds('multicolor', PERMANENT_COLOR_SCHEMES)).toEqual(['red', 'green', 'blue', 'yellow', 'pink']);
  });

  it('every permanent scheme id is a subset of DEFAULT_COLOR_SCHEMES (shared render semantics — review GAP 7)', () => {
    const defIds = new Set(DEFAULT_COLOR_SCHEMES.map((s) => s.id));
    for (const s of PERMANENT_COLOR_SCHEMES) expect(defIds.has(s.id)).toBe(true);
  });
});
