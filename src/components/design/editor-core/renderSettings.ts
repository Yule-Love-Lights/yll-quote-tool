// Global RENDER settings (#32) — app-wide tunables that change how items are
// DRAWN, in both the editor and the read-only portal render. Distinct from the
// per-type SEED defaults (`ToolDefaults`, applied when placing a new item):
// these affect every render, including existing designs, the moment they change.
//
// Mirrors colors.ts: a mutable module global so every renderer reads the latest
// value via getRenderSettings() without threading props through every call site.
// Populated at init from the app's settings store — quote tool: /api/settings
// (applied by the editor shell + the portal); design tool: its own settings.
//
// VENDORED CORE — keep byte-identical with the design tool's editor core. No
// Konva / framework imports so it's safe to import anywhere (server libs too).

export type RenderSettings = {
  // Spritzer ray density: rays per pixel of the spritzer's RENDERED radius
  // (the renderer clamps the resulting count to 7..36). 0.45 ≈ ~22 rays on a
  // 24" spritzer. Higher = denser spray.
  spritzerRayDensity: number;
};

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  spritzerRayDensity: 0.45,
};

let current: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };

export function getRenderSettings(): RenderSettings {
  return current;
}

// Apply a partial update. Each field is validated so a malformed/missing value
// leaves the current (or default) value intact rather than corrupting a render.
export function setRenderSettings(patch: Partial<RenderSettings> | null | undefined): void {
  if (!patch) return;
  const next: RenderSettings = { ...current };
  if (
    typeof patch.spritzerRayDensity === 'number' &&
    Number.isFinite(patch.spritzerRayDensity) &&
    patch.spritzerRayDensity > 0
  ) {
    next.spritzerRayDensity = patch.spritzerRayDensity;
  }
  current = next;
}
