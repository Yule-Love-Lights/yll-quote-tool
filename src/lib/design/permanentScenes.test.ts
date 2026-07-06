import { describe, it, expect } from 'vitest';
import {
  PERMANENT_SCENES,
  PERMANENT_COLOR_SCHEMES,
  permanentSceneById,
  isPermanentColorSchemeId,
  sceneColorsAt,
} from './permanentScenes';
import { resolveSchemeColorIds, CUSTOM_SCHEME_ID } from './colorSchemes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';

const PALETTE_IDS = new Set(DEFAULT_COLORS.map((c) => c.id));

describe('permanent scene set (#88 P6b-3)', () => {
  it('opens on as-designed, includes warm-white, unique ids, no build-your-own', () => {
    const ids = PERMANENT_SCENES.map((s) => s.id);
    expect(ids[0]).toBe('as-designed'); // the default the provider opens on
    expect(ids).toContain('warm-white');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(CUSTOM_SCHEME_ID);
  });

  it('every scene colorId is a real palette id (a typo fails the gates)', () => {
    for (const s of PERMANENT_SCENES) {
      if (s.colorIds === null) continue;
      expect(s.colorIds.length).toBeGreaterThan(0);
      for (const cid of s.colorIds) expect(PALETTE_IDS.has(cid)).toBe(true);
    }
  });

  it('every scene has a valid effect + non-negative speed; motion scenes are multi-color', () => {
    for (const s of PERMANENT_SCENES) {
      expect(['static', 'cycle', 'chase', 'twinkle']).toContain(s.effect);
      expect(s.speedMs).toBeGreaterThanOrEqual(0);
      // a chase/cycle needs >1 color to visibly move (a 1-color "chase" is just static)
      if (s.effect === 'chase' || s.effect === 'cycle') {
        expect(s.colorIds && s.colorIds.length).toBeGreaterThan(1);
        expect(s.speedMs).toBeGreaterThan(0);
      }
    }
  });

  it('PERMANENT_COLOR_SCHEMES is the scenes widened to ColorScheme (same list)', () => {
    expect(PERMANENT_COLOR_SCHEMES.map((s) => s.id)).toEqual(PERMANENT_SCENES.map((s) => s.id));
  });

  it('permanentSceneById resolves known ids, undefined otherwise', () => {
    expect(permanentSceneById('rainbow')?.effect).toBe('chase');
    expect(permanentSceneById('warm-white')?.effect).toBe('static');
    expect(permanentSceneById('candy-cane')).toBeUndefined();
    expect(permanentSceneById(null)).toBeUndefined();
    expect(permanentSceneById(undefined)).toBeUndefined();
  });

  it('isPermanentColorSchemeId accepts only the fixed permanent set', () => {
    for (const s of PERMANENT_SCENES) expect(isPermanentColorSchemeId(s.id)).toBe(true);
    expect(isPermanentColorSchemeId(CUSTOM_SCHEME_ID)).toBe(false); // no custom
    expect(isPermanentColorSchemeId('candy-cane')).toBe(false); // holiday-only
    expect(isPermanentColorSchemeId('')).toBe(false);
    expect(isPermanentColorSchemeId(null)).toBe(false);
    expect(isPermanentColorSchemeId(42)).toBe(false);
  });

  it('resolves against its own list (independent of operator swatch curation)', () => {
    expect(resolveSchemeColorIds('warm-white', PERMANENT_COLOR_SCHEMES)).toEqual(['warm-white']);
    expect(resolveSchemeColorIds('as-designed', PERMANENT_COLOR_SCHEMES)).toBeNull();
    expect(resolveSchemeColorIds('rainbow', PERMANENT_COLOR_SCHEMES)).toEqual(
      permanentSceneById('rainbow')!.colorIds,
    );
  });
});

describe('sceneColorsAt (#88 P6b-3 — the animation stepper)', () => {
  it('static holds the palette regardless of time', () => {
    expect(sceneColorsAt(['a', 'b'], 'static', 0, 200)).toEqual(['a', 'b']);
    expect(sceneColorsAt(['a', 'b'], 'static', 99999, 200)).toEqual(['a', 'b']);
  });

  it('twinkle holds the palette (opacity is animated elsewhere, unused in v1)', () => {
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
    expect(sceneColorsAt(base, 'cycle', 250, 100)).toEqual(['c']);
    expect(sceneColorsAt(base, 'cycle', 300, 100)).toEqual(['a']); // wraps
  });

  it('null / empty base is returned unchanged (as-designed — no override)', () => {
    expect(sceneColorsAt(null, 'chase', 500, 100)).toBeNull();
    expect(sceneColorsAt([], 'chase', 500, 100)).toEqual([]);
  });

  it('a zero/invalid speed never divides by zero — holds at step 0', () => {
    expect(sceneColorsAt(['a', 'b', 'c'], 'chase', 500, 0)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic for a given time (same t → same colors)', () => {
    const base = ['a', 'b', 'c', 'd'];
    expect(sceneColorsAt(base, 'chase', 640, 160)).toEqual(sceneColorsAt(base, 'chase', 640, 160));
  });
});
