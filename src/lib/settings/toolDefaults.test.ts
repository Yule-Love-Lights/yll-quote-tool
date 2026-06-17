import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_DEFAULTS,
  SECTIONS,
  DEFAULTS_TABS,
  mergeToolDefaults,
  sectionByKey,
} from './toolDefaults';

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
