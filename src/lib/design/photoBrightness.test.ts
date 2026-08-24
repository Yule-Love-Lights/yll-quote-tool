import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Scene } from './sceneTypes';
import { brightnessForPhoto, setBrightnessForPhoto } from './photoBrightness';

const LEGACY_SCENE: Scene = { yardsticks: [], items: [], brightness: 35 };

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
});
