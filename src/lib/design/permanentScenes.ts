// Permanent Lighting portal SCENES (#88 P6b-3) — the animated evolution of the
// P6b-2 static color picker. A "scene" is a permanent-only picker option: a color
// palette + an animation effect the portal plays on the live design.
//
// Isolated from colorSchemes.ts (holiday/shared) because permanent scenes are a
// vertical-specific concept: they add an `effect` and are NOT part of the operator's
// holiday swatch list. The freeze path is unchanged from P6b-2 — a scene's `id` is
// what freezes into the approval snapshot via `colorSchemeId`, validated by
// `isPermanentColorSchemeId`. Effects are applied ONLY at portal render time.
//
// The render (render-readonly) cycles each light item's `colorIds` along its bulbs,
// so the two motion effects fall out of recomputing the palette per step:
//   • chase  — ROTATE the palette → the pattern travels along the roofline
//   • cycle  — step a SINGLE color → the whole house fades through the palette
// static holds the palette; twinkle (modeled, unused in v1) is an opacity effect.

import type { ColorScheme } from './colorSchemes';

export type SceneEffect = 'static' | 'cycle' | 'chase' | 'twinkle';

/** A permanent picker option: a ColorScheme plus how it animates. */
export type PermanentScene = ColorScheme & {
  effect: SceneEffect;
  /** Milliseconds per animation step (one palette rotation / color change). */
  speedMs: number;
};

// The fixed curated scene set (built from Naldo's reference install videos, S24).
// `as-designed` (the operator's authored colors) is first so the provider opens on
// it. Every non-null colorId is a built-in palette id (a unit test asserts this).
// ids are STABLE — they're the values that freeze into approved quotes.
export const PERMANENT_SCENES: PermanentScene[] = [
  { id: 'as-designed', label: 'Color',              colorIds: null,                                                              effect: 'static', speedMs: 0 },
  { id: 'warm-white',  label: 'Warm White',         colorIds: ['warm-white'],                                                    effect: 'static', speedMs: 0 },
  { id: 'rainbow',     label: 'Rainbow',            colorIds: ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'], effect: 'chase',  speedMs: 180 },
  { id: 'spooky',      label: 'Purple & Green',     colorIds: ['purple', 'green'],                                               effect: 'chase',  speedMs: 220 },
  { id: 'patriotic',   label: 'Red · White · Blue', colorIds: ['red', 'cool-white', 'blue'],                                     effect: 'chase',  speedMs: 220 },
];

// The scenes viewed as plain ColorSchemes — the picker + the approve-route color
// freeze consume this (drop-in for the P6b-2 PERMANENT_COLOR_SCHEMES; same name so
// call sites only change the import path). PermanentScene extends ColorScheme, so
// this is just a widening.
export const PERMANENT_COLOR_SCHEMES: ColorScheme[] = PERMANENT_SCENES;

const SCENE_BY_ID = new Map<string, PermanentScene>(PERMANENT_SCENES.map((s) => [s.id, s]));

/** The scene record for an id, or undefined if it isn't a permanent scene. */
export function permanentSceneById(id: string | null | undefined): PermanentScene | undefined {
  return id == null ? undefined : SCENE_BY_ID.get(id);
}

// Whether an id is one a PERMANENT customer could legitimately pick/freeze. Does
// NOT accept 'custom' (no build-your-own) or holiday-only schemes — only the fixed
// permanent set. (Moved verbatim from colorSchemes.ts in P6b-3.)
export function isPermanentColorSchemeId(id: unknown): id is string {
  return typeof id === 'string' && SCENE_BY_ID.has(id);
}

/**
 * The palette to feed the renderer at elapsed time `tMs` for a scene's effect —
 * the pure heart of the animation (deterministic in `tMs`, unit-testable without a
 * canvas). `base` is the scene's colorIds (null/empty = as-designed → unchanged).
 *
 *   static / twinkle → the palette unchanged (twinkle animates opacity elsewhere)
 *   chase            → the palette ROTATED by the step index (pattern travels)
 *   cycle            → a SINGLE color, stepping through the palette (whole-house fade)
 */
export function sceneColorsAt(
  base: string[] | null,
  effect: SceneEffect,
  tMs: number,
  speedMs: number,
): string[] | null {
  if (!base || base.length === 0) return base;
  if (effect === 'static' || effect === 'twinkle') return base;
  const n = base.length;
  const steps = speedMs > 0 ? Math.floor(tMs / speedMs) : 0;
  const off = (((steps % n) + n) % n);
  if (effect === 'cycle') return [base[off]!];
  // chase: rotate left by `off`
  return [...base.slice(off), ...base.slice(0, off)];
}
