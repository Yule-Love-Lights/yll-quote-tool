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
    expect(merged.c9.spacingIn).toBe(12); // untouched type still has factory
  });

  it('preserves unknown stored types (forward-compat)', () => {
    const merged = mergeToolDefaults({ future: { foo: 1 } } as never);
    expect(merged.future).toEqual({ foo: 1 });
  });
});
