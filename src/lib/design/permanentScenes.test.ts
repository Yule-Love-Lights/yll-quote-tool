import { describe, it, expect } from 'vitest';
import {
  PERMANENT_SWATCH_SCHEMES,
  PERMANENT_COLOR_SCHEMES,
  PERMANENT_BUILDABLE_IDS,
  PERMANENT_EFFECTS,
  DEFAULT_PERMANENT_EFFECT,
  isPermanentEffect,
  effectSpeedMs,
  sceneColorsAt,
} from './permanentScenes';
import { resolveSchemeColorIds } from './colorSchemes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

const PALETTE_IDS = new Set(DEFAULT_COLORS.map((c) => c.id));

describe('permanent swatch presets (#88 P6b-4)', () => {
  it('opens on As Designed, has unique ids, all colorIds are real palette ids', () => {
    const ids = PERMANENT_SWATCH_SCHEMES.map((s) => s.id);
    expect(ids[0]).toBe('as-designed'); // the default the provider opens on
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of PERMANENT_SWATCH_SCHEMES) {
      if (s.colorIds === null) continue;
      expect(s.colorIds.length).toBeGreaterThan(0);
      for (const cid of s.colorIds) expect(PALETTE_IDS.has(cid)).toBe(true);
    }
  });

  it('offers full color freedom: solids + multi-color presets + a build-your-own palette', () => {
    const ids = PERMANENT_SWATCH_SCHEMES.map((s) => s.id);
    expect(ids).toContain('blue'); // a solid
    expect(ids).toContain('rainbow'); // a multi-color preset
    expect(PERMANENT_BUILDABLE_IDS.length).toBeGreaterThan(3);
    expect(PERMANENT_BUILDABLE_IDS).not.toContain('black');
    for (const id of PERMANENT_BUILDABLE_IDS) expect(PALETTE_IDS.has(id)).toBe(true);
  });

  it('PERMANENT_COLOR_SCHEMES aliases the swatch presets (import-compat)', () => {
    expect(PERMANENT_COLOR_SCHEMES).toBe(PERMANENT_SWATCH_SCHEMES);
  });

  it('resolves a preset against its own list', () => {
    expect(resolveSchemeColorIds('blue', PERMANENT_COLOR_SCHEMES)).toEqual(['blue']);
    expect(resolveSchemeColorIds('as-designed', PERMANENT_COLOR_SCHEMES)).toBeNull();
  });
});

describe('permanent effects (#88 P6b-4)', () => {
  it('offers Solid + the two motion effects with sane speeds; default is a motion effect', () => {
    const effects = PERMANENT_EFFECTS.map((e) => e.effect);
    expect(effects).toContain('static');
    expect(effects).toContain('chase');
    expect(effects).toContain('cycle');
    for (const e of PERMANENT_EFFECTS) {
      expect(e.label.length).toBeGreaterThan(0);
      if (e.effect === 'static') expect(e.speedMs).toBe(0);
      else expect(e.speedMs).toBeGreaterThan(0);
    }
    expect(['chase', 'cycle']).toContain(DEFAULT_PERMANENT_EFFECT); // animate by default
  });

  it('isPermanentEffect accepts only the offered effects', () => {
    expect(isPermanentEffect('static')).toBe(true);
    expect(isPermanentEffect('chase')).toBe(true);
    expect(isPermanentEffect('cycle')).toBe(true);
    expect(isPermanentEffect('twinkle')).toBe(false); // modeled but not offered yet
    expect(isPermanentEffect('nope')).toBe(false);
    expect(isPermanentEffect(null)).toBe(false);
    expect(isPermanentEffect(42)).toBe(false);
  });

  it('effectSpeedMs returns the offered speed, 0 for static/unknown', () => {
    expect(effectSpeedMs('static')).toBe(0);
    expect(effectSpeedMs('chase')).toBeGreaterThan(0);
    expect(effectSpeedMs('twinkle')).toBe(0); // not offered → 0
  });
});

describe('sceneColorsAt (#88 — the animation stepper)', () => {
  it('static / twinkle hold the palette regardless of time', () => {
    expect(sceneColorsAt(['a', 'b'], 'static', 99999, 200)).toEqual(['a', 'b']);
    expect(sceneColorsAt(['a', 'b'], 'twinkle', 12345, 200)).toEqual(['a', 'b']);
  });

  it('chase ROTATES the palette by the step index (pattern travels)', () => {
    const base = ['a', 'b', 'c'];
    expect(sceneColorsAt(base, 'chase', 0, 100)).toEqual(['a', 'b', 'c']);
    expect(sceneColorsAt(base, 'chase', 100, 100)).toEqual(['b', 'c', 'a']);
    expect(sceneColorsAt(base, 'chase', 250, 100)).toEqual(['c', 'a', 'b']);
    expect(sceneColorsAt(base, 'chase', 300, 100)).toEqual(['a', 'b', 'c']); // wraps
  });

  it('cycle steps a SINGLE color through the palette (whole-house fade)', () => {
    const base = ['a', 'b', 'c'];
    expect(sceneColorsAt(base, 'cycle', 0, 100)).toEqual(['a']);
    expect(sceneColorsAt(base, 'cycle', 100, 100)).toEqual(['b']);
    expect(sceneColorsAt(base, 'cycle', 300, 100)).toEqual(['a']); // wraps
  });

  it('null / empty base is returned unchanged (as-designed — no override)', () => {
    expect(sceneColorsAt(null, 'chase', 500, 100)).toBeNull();
    expect(sceneColorsAt([], 'chase', 500, 100)).toEqual([]);
  });

  it('a zero speed never divides by zero — holds at step 0', () => {
    expect(sceneColorsAt(['a', 'b', 'c'], 'chase', 500, 0)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic for a given time', () => {
    const base = ['a', 'b', 'c', 'd'];
    expect(sceneColorsAt(base, 'chase', 640, 160)).toEqual(sceneColorsAt(base, 'chase', 640, 160));
  });
});
