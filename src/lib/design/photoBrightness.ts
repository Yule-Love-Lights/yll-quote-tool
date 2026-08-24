import type { Scene } from './sceneTypes';

export function brightnessForPhoto(scene: Scene, photoId: string | null): number {
  const baseBrightness = scene.brightness ?? 50;
  if (!photoId) return baseBrightness;
  return scene.extraPhotoBrightness?.[photoId] ?? baseBrightness;
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
