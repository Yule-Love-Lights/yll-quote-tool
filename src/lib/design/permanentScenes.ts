// Permanent Lighting portal COLOR + EFFECT model (#88 P6b-3/P6b-4).
//
// Permanent (Omni/Ascend RGB puck) systems are app-controlled, so the portal gives
// the customer full color control (like the holiday picker) PLUS a separate effect
// choice — decoupled, so any color can play any effect:
//   • COLOR  — a permanent swatch preset, a build-your-own pattern, or "As Designed"
//              (the operator's authored colors). Reuses the holiday picker UI over
//              the permanent swatch list below. Freezes via `colorSchemeId` (+ custom
//              pattern), exactly like holiday.
//   • EFFECT — Solid / Chase / Fade, picked separately (PERMANENT_EFFECTS). Freezes
//              via `permanentEffect`. Applied ONLY at portal render time.
//
// The render (render-readonly) cycles each light item's colorIds along its bulbs, so
// the two motion effects fall out of recomputing the palette per step (sceneColorsAt):
//   chase = rotate the palette (pattern travels) · cycle = step a single color (fade).

import type { ColorScheme } from './colorSchemes';
import { DEFAULT_BUILDABLE_COLOR_IDS } from './colorSchemes';

export type SceneEffect = 'static' | 'cycle' | 'chase' | 'twinkle';

/** A permanent picker option: a ColorScheme plus how it animates. Kept for the
 *  Settings-editable preset shape (a preset can carry a default effect). */
export type PermanentScene = ColorScheme & { effect: SceneEffect; speedMs: number };

// ── COLOR: the permanent swatch presets ─────────────────────────────────────
// The quick-pick color presets on the permanent portal (in addition to the full
// palette via build-your-own). "As Designed" is first (the default the provider
// opens on = the operator's authored colors, e.g. the blue Naldo drew). RGB pucks
// look good as solids, so unlike the holiday list this includes single colors.
// Every colorId is a built-in palette id (a unit test asserts it). ids are STABLE —
// they're what freezes into an approved quote. (#88 P6b-4 will make this list
// Settings-editable, mirroring the #101 holiday swatches; these are the defaults.)
export const PERMANENT_SWATCH_SCHEMES: ColorScheme[] = [
  { id: 'as-designed', label: 'As Designed',        colorIds: null },
  { id: 'warm-white',  label: 'Warm White',         colorIds: ['warm-white'] },
  { id: 'cool-white',  label: 'Pure White',         colorIds: ['cool-white'] },
  { id: 'blue',        label: 'Blue',               colorIds: ['blue'] },
  { id: 'red',         label: 'Red',                colorIds: ['red'] },
  { id: 'green',       label: 'Green',              colorIds: ['green'] },
  { id: 'purple',      label: 'Purple',             colorIds: ['purple'] },
  { id: 'teal',        label: 'Teal',               colorIds: ['teal'] },
  { id: 'orange',      label: 'Orange',             colorIds: ['orange'] },
  { id: 'pink',        label: 'Pink',               colorIds: ['pink'] },
  { id: 'rainbow',     label: 'Rainbow',            colorIds: ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] },
  { id: 'spooky',      label: 'Purple & Green',     colorIds: ['purple', 'green'] },
  { id: 'patriotic',   label: 'Red · White · Blue', colorIds: ['red', 'cool-white', 'blue'] },
];

/** Alias kept so existing importers (approve route, portal page) don't churn. */
export const PERMANENT_COLOR_SCHEMES: ColorScheme[] = PERMANENT_SWATCH_SCHEMES;

/** The build-your-own palette offered on the permanent picker — every non-black
 *  palette color (permanent pucks can be any color). Same default as holiday. */
export const PERMANENT_BUILDABLE_IDS: string[] = DEFAULT_BUILDABLE_COLOR_IDS;

// ── EFFECT: the separate motion choice ──────────────────────────────────────
export type PermanentEffectOption = { effect: SceneEffect; label: string; speedMs: number };

// The selectable effects (static for now). Solid = no motion; Chase = the pattern
// travels along the roofline; Fade = the whole house steps through the colors.
// speedMs = ms per step. twinkle is modeled (SceneEffect) but not offered yet — it
// needs per-bulb on/off, a harder follow-up.
export const PERMANENT_EFFECTS: PermanentEffectOption[] = [
  { effect: 'static', label: 'Solid', speedMs: 0 },
  { effect: 'chase',  label: 'Chase', speedMs: 180 },
  { effect: 'cycle',  label: 'Fade',  speedMs: 700 },
];

/** The permanent portal opens on this effect — Chase, so a multi-color scene moves
 *  by default (a single color stays solid regardless). */
export const DEFAULT_PERMANENT_EFFECT: SceneEffect = 'chase';

const EFFECT_BY_ID = new Map<SceneEffect, PermanentEffectOption>(PERMANENT_EFFECTS.map((e) => [e.effect, e]));

/** Whether a value is a selectable permanent effect. */
export function isPermanentEffect(v: unknown): v is SceneEffect {
  return typeof v === 'string' && EFFECT_BY_ID.has(v as SceneEffect);
}

/** The step speed (ms) for an effect, or 0 for static/unknown. */
export function effectSpeedMs(effect: SceneEffect): number {
  return EFFECT_BY_ID.get(effect)?.speedMs ?? 0;
}

/**
 * The palette to feed the renderer at elapsed time `tMs` for an effect — the pure
 * heart of the animation (deterministic in `tMs`, unit-testable without a canvas).
 * `base` is the chosen colors (null/empty = as-designed → unchanged).
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
