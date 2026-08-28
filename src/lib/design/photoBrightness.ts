import type { Scene } from './sceneTypes';

// Row 348 (S49 wrap admin lens): unlike `lightScale` — clamped on EVERY read
// via `normalizeLightScale` (editor.ts's `activeLightScale()` and
// render-readonly.ts both call it, so a raw out-of-range stored value
// self-corrects at render time) — nothing clamps brightness on read.
// `drawTint()` (editor.ts) and `renderReadOnlyDesign()` (render-readonly.ts)
// both read `scene.brightness` / `extraPhotoBrightness` straight off
// `brightnessForPhoto()`, and neither this function nor its 5 call sites
// (editor.ts x2, DesignReprise.tsx, PhotoGallery.tsx, InteractiveHero.tsx)
// clamp it. A caller-supplied value outside [0,100] would persist as-is and
// paint an opaque black/white tint over the whole design on every render
// path — the portal included. Used by the PUT route to clamp at write time
// instead of adding a read-time guard to five separate call sites.
export function clampBrightness(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}

export function brightnessForPhoto(scene: Scene, photoId: string | null): number {
  const baseBrightness = scene.brightness ?? 50;
  if (!photoId) return baseBrightness;
  return scene.extraPhotoBrightness?.[photoId] ?? baseBrightness;
}

/** Row 371: the scene with one photo's per-photo brightness override removed.
 *  A deleted photo's override is not attached to any item, so an item-only
 *  prune never reached it and the key survived the delete forever.
 *
 *  Shared by BOTH sides of that delete on purpose. The server prunes the
 *  stored scene (`removeDesignExtraPhoto`), and the still-mounted editor has
 *  to prune its RESIDENT copy in the same breath — the editor saves the whole
 *  scene on every autosave, so a client that kept the key would write it
 *  straight back over the server's prune on the very next edit. One
 *  implementation means the two can never disagree about what "pruned" means.
 *
 *  Returns the SAME scene object when there is nothing to remove, so callers
 *  can use reference equality to decide whether anything changed. */
export function removeBrightnessForPhoto(scene: Scene, photoId: string): Scene {
  const current = scene.extraPhotoBrightness;
  if (!current || !Object.prototype.hasOwnProperty.call(current, photoId)) return scene;
  const next = { ...current };
  delete next[photoId];
  return { ...scene, extraPhotoBrightness: next };
}

export function setBrightnessForPhoto(
  scene: Scene,
  extraPhotoIds: string[],
  photoId: string | null,
  brightness: number,
): Scene {
  if (photoId) {
    return {
      ...scene,
      extraPhotoBrightness: {
        ...scene.extraPhotoBrightness,
        [photoId]: brightness,
      },
    };
  }

  const previousBaseBrightness = scene.brightness ?? 50;
  const extraPhotoBrightness = { ...scene.extraPhotoBrightness };
  for (const id of extraPhotoIds) {
    extraPhotoBrightness[id] ??= previousBaseBrightness;
  }

  return {
    ...scene,
    brightness,
    ...(extraPhotoIds.length > 0 || scene.extraPhotoBrightness
      ? { extraPhotoBrightness }
      : {}),
  };
}
