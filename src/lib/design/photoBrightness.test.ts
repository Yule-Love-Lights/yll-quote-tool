import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Scene } from './sceneTypes';
import { brightnessForPhoto, clampBrightness, setBrightnessForPhoto } from './photoBrightness';

const LEGACY_SCENE: Scene = { yardsticks: [], items: [], brightness: 35 };

// Row 348 (S49 wrap admin lens): the PUT route clamps brightness at write
// time with this helper, since nothing clamps it at read time the way
// normalizeLightScale clamps lightScale on every render path.
describe('clampBrightness', () => {
  it('falls back to neutral (50) for anything that is not a real number', () => {
    for (const bad of [undefined, null, '80', '', {}, [], true, NaN, Infinity, -Infinity]) {
      expect(clampBrightness(bad)).toBe(50);
    }
  });

  it('clamps into [0,100] instead of trusting the stored value', () => {
    expect(clampBrightness(-50)).toBe(0);
    expect(clampBrightness(9000)).toBe(100);
  });

  it('passes an in-range value through untouched', () => {
    expect(clampBrightness(0)).toBe(0);
    expect(clampBrightness(35)).toBe(35);
    expect(clampBrightness(100)).toBe(100);
  });
});

describe('per-photo design brightness', () => {
  it('keeps the existing scene brightness as the fallback for legacy designs', () => {
    expect(brightnessForPhoto(LEGACY_SCENE, null)).toBe(35);
    expect(brightnessForPhoto(LEGACY_SCENE, 'left-photo')).toBe(35);
  });

  it('changing the base photo snapshots every extra so they do not change with it', () => {
    const changed = setBrightnessForPhoto(
      LEGACY_SCENE,
      ['left-photo', 'right-photo'],
      null,
      80,
    );

    expect(brightnessForPhoto(changed, null)).toBe(80);
    expect(brightnessForPhoto(changed, 'left-photo')).toBe(35);
    expect(brightnessForPhoto(changed, 'right-photo')).toBe(35);
    expect(LEGACY_SCENE).toEqual({ yardsticks: [], items: [], brightness: 35 });
  });

  it('keeps every photo independent through JSON serialization', () => {
    const leftChanged = setBrightnessForPhoto(
      LEGACY_SCENE,
      ['left-photo', 'right-photo'],
      'left-photo',
      10,
    );

    expect(brightnessForPhoto(leftChanged, null)).toBe(35);
    expect(brightnessForPhoto(leftChanged, 'left-photo')).toBe(10);
    expect(brightnessForPhoto(leftChanged, 'right-photo')).toBe(35);

    const baseChanged = setBrightnessForPhoto(
      leftChanged,
      ['left-photo', 'right-photo'],
      null,
      80,
    );
    const allChanged = setBrightnessForPhoto(
      baseChanged,
      ['left-photo', 'right-photo'],
      'right-photo',
      60,
    );
    const reopened = JSON.parse(JSON.stringify(allChanged)) as Scene;

    expect(brightnessForPhoto(reopened, null)).toBe(80);
    expect(brightnessForPhoto(reopened, 'left-photo')).toBe(10);
    expect(brightnessForPhoto(reopened, 'right-photo')).toBe(60);
  });

  it('uses neutral brightness when a legacy scene has no saved value', () => {
    const scene: Scene = { yardsticks: [], items: [] };

    expect(brightnessForPhoto(scene, null)).toBe(50);
    expect(brightnessForPhoto(scene, 'new-photo')).toBe(50);
  });

  it('wires the active photo through the editor and every multi-photo portal view', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const editor = source('../../components/design/editor-core/editor.ts');

    expect(editor).toContain('const b = brightnessForPhoto(scene, activePhotoId);');
    expect(editor).toContain('brightnessEl.value = String(brightnessForPhoto(scene, activePhotoId));');
    expect(editor.match(/setBrightnessForPhoto\(scene, extraPhotoIds, activePhotoId,/g)).toHaveLength(2);

    const hero = source('../../components/portal/snowglobe/InteractiveHero.tsx');
    expect(hero).toContain('brightness: brightnessForPhoto(design.scene, activePhotoId)');
    expect(hero).toContain('scene={activeScene ?? design.scene}');

    const reprise = source('../../components/portal/dark/DesignReprise.tsx');
    expect(reprise).toContain('brightness: brightnessForPhoto(design.scene, active.id)');
    expect(reprise).toContain('scene={activeScene}');

    const gallery = source('../../components/portal/dark/PhotoGallery.tsx');
    expect(gallery).toContain('brightness: brightnessForPhoto(design.scene, p.id)');
    expect(gallery).toContain("scene={scenesByPhotoId.get(p.id ?? 'base')!}");
    expect(gallery).toContain('scene={scene}');
  });

  // Row 348: undo()/redo() reassign `scene` and call redrawScene(), which
  // fixes the CANVAS (bulbs resize via activeLightScale()), but neither used
  // to resync the brightness slider or repaint its tint — Konva canvas code
  // has no component-render test infra here (see lightScale.test.ts's own
  // note on why editor.ts can't be imported in this headless environment), so
  // this pins the fix as source text the way the test above already does.
  it('resyncs the brightness control + tint in both undo() and redo()', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const editor = source('../../components/design/editor-core/editor.ts');
    const [undoBody] = editor.match(/function undo\(\) \{[\s\S]*?\n  \}/) ?? [''];
    const [redoBody] = editor.match(/function redo\(\) \{[\s\S]*?\n  \}/) ?? [''];

    for (const body of [undoBody, redoBody]) {
      expect(body).toContain('redrawScene();');
      expect(body).toContain('brightnessEl.value = String(brightnessForPhoto(scene, activePhotoId));');
      expect(body).toContain('drawTint();');
    }
  });
});
