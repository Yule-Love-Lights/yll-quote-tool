import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_DEFAULTS,
  SECTIONS,
  DEFAULTS_TABS,
  mergeToolDefaults,
  sectionByKey,
} from './toolDefaults';
import {
  WREATH_SIZES,
  BOW_SIZES,
  GARLAND_SIZES,
  SPRITZER_SIZES,
  POLE_HEIGHTS,
  C9_SPACINGS,
  MINI_SPACINGS,
  BISTRO_SPACINGS,
} from '@/components/design/editor-core/sizePresets';

describe('SECTIONS / factory integrity', () => {
  it('every section key has factory defaults', () => {
    for (const s of SECTIONS) {
      expect(DEFAULT_TOOL_DEFAULTS[s.key], `missing factory for ${s.key}`).toBeDefined();
    }
  });

  it('every non-color-pattern field key exists in the factory defaults for its type', () => {
    for (const s of SECTIONS) {
      const factory = DEFAULT_TOOL_DEFAULTS[s.key];
      for (const f of s.fields) {
        // colorPattern is optional on some factory entries (e.g. it defaults to
        // warm-white at render); every other field must have a factory value.
        if (f.kind === 'color-pattern') continue;
        expect(factory[f.key], `${s.key}.${f.key} has no factory value`).toBeDefined();
      }
    }
  });

  it('every tab references real sections', () => {
    for (const tab of DEFAULTS_TABS) {
      for (const key of tab.sectionKeys) {
        expect(sectionByKey(key), `tab ${tab.id} → unknown section ${key}`).toBeDefined();
      }
    }
  });
});

// #223: Settings' decor/pole size dropdowns used to offer the pre-#202
// 4/5-value inch supersets after the editor itself had already trimmed to 3
// presets. This locks the two lists in lockstep (via the shared import) and
// documents which field carries which type's options.
describe('decor/pole size fields mirror the editor presets (#223)', () => {
  const CASES: { sectionKey: string; fieldKey: string; expected: readonly number[] }[] = [
    { sectionKey: 'wreath', fieldKey: 'sizeIn', expected: WREATH_SIZES },
    { sectionKey: 'bow', fieldKey: 'sizeIn', expected: BOW_SIZES },
    { sectionKey: 'garland', fieldKey: 'sizeIn', expected: GARLAND_SIZES },
    { sectionKey: 'spritzer', fieldKey: 'sizeIn', expected: SPRITZER_SIZES },
    { sectionKey: 'pole', fieldKey: 'heightIn', expected: POLE_HEIGHTS },
  ];

  for (const { sectionKey, fieldKey, expected } of CASES) {
    it(`${sectionKey}.${fieldKey} options exactly match the editor's ${sectionKey} presets`, () => {
      const section = sectionByKey(sectionKey);
      const field = section?.fields.find((f) => f.key === fieldKey);
      expect(field?.kind).toBe('spacing');
      expect(field && 'options' in field ? field.options : null).toEqual([...expected]);
    });
  }

  it('none of the trimmed fields still offer the old 4/5-value supersets', () => {
    const wreath = sectionByKey('wreath')?.fields.find((f) => f.key === 'sizeIn');
    expect(wreath && 'options' in wreath ? wreath.options : null).not.toContain(48); // dropped wreath tier
    const bow = sectionByKey('bow')?.fields.find((f) => f.key === 'sizeIn');
    expect(bow && 'options' in bow ? bow.options : null).toHaveLength(3);
    const pole = sectionByKey('pole')?.fields.find((f) => f.key === 'heightIn');
    expect(pole && 'options' in pole ? pole.options : null).not.toContain(144); // dropped pole tier
  });
});

// #248 (row 248): same lockstep-import precedent as #223 above, for the
// c9/mini/bistro light-spacing fields (SPACINGS_BY_TYPE). Permanent is
// deliberately excluded -- its field keeps its own [8] literal, unchanged.
describe('light-spacing fields mirror the editor presets (#248)', () => {
  const CASES: { sectionKey: string; expected: readonly number[] }[] = [
    { sectionKey: 'c9', expected: C9_SPACINGS },
    { sectionKey: 'mini', expected: MINI_SPACINGS },
    { sectionKey: 'bistro', expected: BISTRO_SPACINGS },
  ];

  for (const { sectionKey, expected } of CASES) {
    it(`${sectionKey}.spacingIn options exactly match the editor's ${sectionKey} spacing presets`, () => {
      const section = sectionByKey(sectionKey);
      const field = section?.fields.find((f) => f.key === 'spacingIn');
      expect(field?.kind).toBe('spacing');
      expect(field && 'options' in field ? field.options : null).toEqual([...expected]);
    });
  }

  it("permanent's spacingIn field is untouched -- still the single [8] option", () => {
    const permanent = sectionByKey('permanent')?.fields.find((f) => f.key === 'spacingIn');
    expect(permanent && 'options' in permanent ? permanent.options : null).toEqual([8]);
  });

  it('none of the trimmed light-spacing fields still offer the old 5/6-value supersets', () => {
    const c9 = sectionByKey('c9')?.fields.find((f) => f.key === 'spacingIn');
    expect(c9 && 'options' in c9 ? c9.options : null).not.toContain(36); // dropped c9 spacing tier
    const mini = sectionByKey('mini')?.fields.find((f) => f.key === 'spacingIn');
    expect(mini && 'options' in mini ? mini.options : null).toHaveLength(3);
    const bistro = sectionByKey('bistro')?.fields.find((f) => f.key === 'spacingIn');
    expect(bistro && 'options' in bistro ? bistro.options : null).not.toContain(12); // dropped bistro spacing tier
  });
});

// #223: a legacy stored value that the #202/#223 trim dropped from the preset
// list must still round-trip through mergeToolDefaults unchanged — the merge
// layer must not coerce/clamp it onto one of the 3 kept presets. (The UI-side
// "stays selectable" affordance for this same value is covered separately in
// SettingsField.test.ts's spacingSelectOptions tests.)
describe('legacy (pre-#202) size value round-trips through mergeToolDefaults (#223)', () => {
  it('a dropped wreath tier (48") is preserved exactly, not snapped to a kept preset', () => {
    expect(WREATH_SIZES).not.toContain(48);
    const merged = mergeToolDefaults({ wreath: { sizeIn: 48 } });
    expect(merged.wreath.sizeIn).toBe(48);
  });

  it('a dropped pole tier (144") is preserved exactly, not snapped to a kept preset', () => {
    expect(POLE_HEIGHTS).not.toContain(144);
    const merged = mergeToolDefaults({ pole: { heightIn: 144 } });
    expect(merged.pole.heightIn).toBe(144);
  });
});

// #843 fix 1 (post-#248 review): every factory spacingIn -- the value a
// FRESH install seeds before any app_settings.defaults row has ever been
// saved -- must itself be a member of that type's own preset list.
// Previously c9/bistro's factory value was a leftover "12" hand literal that
// #248's trim orphaned (valid pre-trim, off-preset after): a brand new
// environment would silently hit editor.ts's pre-existing
// applyDefaultsForCurrentType off-preset clamp on the very first tool
// select, snapping to Medium with no record of why. c9/bistro now derive
// from their own preset array's middle entry instead (toolDefaults.ts), so
// this locks both "on-list" and the exact expected value, and a future trim
// can't orphan it again without this test catching it.
describe('every factory spacingIn is a member of its own preset list (#843 fix 1)', () => {
  const CASES: { type: string; options: readonly number[] }[] = [
    { type: 'c9', options: C9_SPACINGS },
    { type: 'mini', options: MINI_SPACINGS },
    { type: 'permanent', options: [8] },
    { type: 'bistro', options: BISTRO_SPACINGS },
  ];

  for (const { type, options } of CASES) {
    it(`${type}.spacingIn factory default is one of its own presets`, () => {
      expect(options).toContain(DEFAULT_TOOL_DEFAULTS[type].spacingIn);
    });
  }

  it("c9/bistro factory defaults land on Medium (the array's middle entry), matching editor.ts's own ToolState-seed convention", () => {
    expect(DEFAULT_TOOL_DEFAULTS.c9.spacingIn).toBe(15);
    expect(DEFAULT_TOOL_DEFAULTS.bistro.spacingIn).toBe(18);
  });
});

// A genuinely legacy STORED value (e.g. a staff account whose
// app_settings.defaults row predates #248/#843) must still round-trip
// through mergeToolDefaults unchanged -- the merge layer must not
// coerce/clamp it onto one of the 3 kept presets, same guarantee #223
// already locked for decor sizes above. Distinct from the factory-integrity
// block above: this is about a value a user actually SAVED, not the
// out-of-the-box default.
describe('legacy (pre-#248) stored spacing value round-trips through mergeToolDefaults (#248)', () => {
  it('a dropped c9 spacing tier (36", the pre-#248 max) is preserved exactly, not snapped to a kept preset', () => {
    expect(C9_SPACINGS).not.toContain(36);
    const merged = mergeToolDefaults({ c9: { spacingIn: 36 } });
    expect(merged.c9.spacingIn).toBe(36);
  });

  it('a dropped bistro spacing tier (12", the pre-#843 factory default) is preserved exactly, not snapped to a kept preset', () => {
    expect(BISTRO_SPACINGS).not.toContain(12);
    const merged = mergeToolDefaults({ bistro: { spacingIn: 12 } });
    expect(merged.bistro.spacingIn).toBe(12);
  });
});

describe('mergeToolDefaults', () => {
  it('returns the full factory set when nothing is stored', () => {
    const merged = mergeToolDefaults(null);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(DEFAULT_TOOL_DEFAULTS).sort());
    expect(merged.spritzer.sizeIn).toBe(24);
  });

  it('overlays stored values over the factory, per field', () => {
    const merged = mergeToolDefaults({ spritzer: { sizeIn: 36 } });
    expect(merged.spritzer.sizeIn).toBe(36); // stored wins
    expect(merged.spritzer.colorPattern).toEqual(['warm-white']); // factory field preserved
    expect(merged.c9.spacingIn).toBe(15); // untouched type still has factory (#843 fix 1: was 12 pre-fix)
  });

  it('preserves unknown stored types (forward-compat)', () => {
    const merged = mergeToolDefaults({ future: { foo: 1 } } as never);
    expect(merged.future).toEqual({ foo: 1 });
  });
});
