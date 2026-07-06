# Permanent portal animations — design

**Ticket:** #88 permanent-lighting follow-on (call it **P6b-3**). Builds on P6b-2 (PR #387: the static warm-white↔color picker + editable/frozen warranty).
**Date:** 2026-07-04 · **Author:** Naldo + Claude (S24 brainstorm)

## Summary

Permanent (Omni/Ascend RGB puck) lighting is app-controlled and animates — rainbow sweeps, 2-color patterns, solid washes. The portal today renders the design **static**. This adds a **permanent-only** animated preview: the customer previews and picks an animated *scene* (which freezes like the color choice), and the portal design animates it — driven by a portal-side loop that also paints a **soft colored facade glow** so it approximates the immersive look of real installs (Naldo's reference videos), not just moving dots.

Scope is deliberately small: a fixed curated scene set, permanent-only, the hero render only, editor-core untouched.

## Goals

- Permanent portal shows the design **animating** the customer's chosen scene (cycle / chase / static), with a soft facade glow approximating a real RGB install.
- The customer **picks** a scene from the P6b-2 picker (now animated); the pick **freezes** into the approval snapshot via the existing `colorSchemeId` (no new field).
- Kind to phones: animate only while on-screen, back off when scrolled away, and fall back to a static frame under `prefers-reduced-motion`.

## Non-goals (v1 — YAGNI)

- **No operator scene-studio.** The scene set is a fixed curated constant (built from the reference videos), not Settings-editable. (A future P6b-4 could add editing.)
- **No animation on holiday/event.** Permanent-only.
- **No animation off the hero.** The "What's Included" second render + the approved page + admin thumbnails stay **static** (they show the picked scene's resting colors). Only the hero animates. Keeps CPU bounded to one canvas.
- **No editor-core / design-tool change.** The animation is a portal-side layer over the already-mounted Konva render (no design-tool relay).
- **Twinkle effect** is modeled but ships **unused** (no reference needed it) — available for a later scene without a model change.

## What the reference videos are (the concrete scene set)

Seven clips (`public/IMG_35*/36*/37*/39*.MOV`), classified from extracted frames:

| Clips | Look | Maps to |
|---|---|---|
| IMG_3594, 3744, 6592, 6617 | full-spectrum **rainbow** sweeping across the roofline + facade | `cycle`, rainbow palette |
| IMG_3998 | **purple + green** alternating | `chase`, 2-color palette |
| IMG_6618 | **red + blue** alternating (patriotic) | `chase`, 2-color palette |
| IMG_6607 | **solid purple** wash | `static`, single color |

**Starter scene set** (fixed constant; ids are stable — they're what freezes):

| id | label | effect | palette (built-in color ids) |
|---|---|---|---|
| `as-designed` | Color | static | (the operator's authored colors — from P6b-2) |
| `warm-white` | Warm White | static | `warm-white` — from P6b-2 |
| `rainbow-cycle` | Rainbow | cycle | `red, orange, yellow, green, teal, blue, purple, pink` |
| `spooky` | Purple & Green | chase | `purple, green` |
| `patriotic` | Red · White · Blue | chase | `red, cool-white, blue` |

All palette ids already exist in `editor-core/colors.ts` — **no new palette colors needed**. (Final labels/colors are tunable; the model + this set are the contract.)

## Design

### 1. Scene model

Extend the permanent picker's scheme records with an optional animation descriptor:

```
type SceneEffect = 'static' | 'cycle' | 'chase' | 'twinkle';
type PermanentScene = ColorScheme & { effect?: SceneEffect; speedMs?: number };
```

`PERMANENT_COLOR_SCHEMES` (added in P6b-2) becomes the starter `PERMANENT_SCENES` list above. A scene with no `effect` (or `effect: 'static'`) renders exactly as P6b-2 does today — so the model is backward-compatible and static scenes are unchanged. `isPermanentColorSchemeId` continues to gate what a permanent quote may freeze.

### 2. Animation controller (portal-side, editor-core untouched)

A new controller in the **portal's** `DesignCanvas` wrapper (`src/components/design/DesignCanvas.tsx` is the read-only Konva mount) runs a single `requestAnimationFrame` loop when an animated permanent scene is active. Each frame it recomputes the effective bulb colors for time `t` and applies them to the already-mounted render **imperatively** (no React re-render, no stage remount):

- **cycle** — rotate the scene palette by a time-based offset applied uniformly → the whole roofline sweeps through the colors.
- **chase** — rotate the palette offset **per bulb position** along each strand → the colors travel along the roofline.
- **twinkle** (unused v1) — per-bulb opacity flicker.

The per-frame color math is a **pure function** `sceneColorsAt(scene, t, bulbIndex)` (deterministic given `t`), unit-tested without a canvas. The controller is the only stateful/imperative piece.

**Spike/risk:** confirm the mounted render exposes a cheap per-frame recolor path (update fills without remounting the Konva stage). If it doesn't, add a **minimal portal-side recolor** hook in the wrapper (still not editor-core). `chase` needs bulbs addressable in strand order — verify the scene/render preserves per-strand bulb order; if it can't be made smooth on a complex roofline, `chase` scenes **degrade to `cycle`** (flagged before ship).

### 3. Facade glow (1b)

A portal-side **glow layer** behind the design canvas: a soft, blurred colored wash positioned along the roofline that tints the facade with the scene's current dominant colors, animated by the same loop. Implemented as a portal-only overlay (CSS/canvas blurred gradient or blurred Konva shapes **behind** the pucks) — **not** part of the design render, so editor-core and the design tool are untouched. This is what makes the preview read like the reference videos instead of bare moving dots.

**Spike/risk:** getting the glow tasteful (position, blur, blend, intensity) is the aesthetic risk. Spike it against a real permanent design; if it can't be made to look premium, ship 1a (dots only) and revisit. Naldo device-checks the glow before merge.

### 4. Picker + freeze

The P6b-2 `PermanentColorToggle` chips become the scene list. Tapping a chip selects + plays that scene; the selected scene auto-plays (smart-play). The pick freezes through the **existing** path: `colorSchemeId` = the scene id, already validated (`isPermanentColorSchemeId`) and frozen into `approval_snapshot.customerSelection` by the approve + staff-approve routes (P6b-2). No route/snapshot change. The approved page shows the picked scene's **resting** colors (static).

### 5. Smart-play + accessibility

- **On-screen only:** an `IntersectionObserver` on the hero starts the loop when visible, stops it when scrolled away.
- **Back-off:** after N loops with no interaction, settle to the resting frame (avoids indefinite battery drain on a parked tab). Re-arms on interaction/scroll-back.
- **Reduced motion:** `prefers-reduced-motion: reduce` → never start the loop; render the scene's resting frame. (WCAG 2.3.3 / motion sensitivity.)
- One `rAF` loop, one canvas — bounded cost.

## Components / files (anticipated)

- `src/lib/design/permanentScenes.ts` (or extend `colorSchemes.ts`) — the `PermanentScene` model + `PERMANENT_SCENES` set + `sceneColorsAt(scene, t, i)` pure fn + tests.
- `src/components/design/DesignCanvas.tsx` — the animation controller + glow layer (portal-side; gated so non-animated / non-permanent renders are byte-identical to today).
- `src/components/portal/dark/PermanentColorToggle.tsx` — chips already exist (P6b-2); minor: play/selected affordance.
- No route/adapter/appSettings changes (freeze reuses P6b-2).

## Testing

- **Pure:** `sceneColorsAt` — cycle rotates uniformly, chase rotates per bulb index, static is time-invariant, deterministic for a given `t`. Palette-validity (ids exist) like the P6b-2 scheme tests.
- **A11y:** reduced-motion → controller never starts (resting frame). On-screen gating logic (pure part).
- **Freeze:** reuse P6b-2's approve/staff-approve/adapter tests (scene ids are just `colorSchemeId` values — already covered; add a case that an animated scene id freezes + rejects a non-permanent id).
- **Visual/motion + glow:** device check with Naldo against a real permanent design (can't unit-test "looks premium").

## Sequencing

1. Merge **PR #387** first (the static picker + warranty this builds on).
2. Build P6b-3 as its own PR: model + pure fn (TDD) → animation controller (spike the recolor path) → facade glow (spike the look) → wire the picker → smart-play/a11y → device-check with Naldo → gate → merge-go.
3. If either spike (recolor path / glow aesthetics) fails, degrade gracefully (chase→cycle; 1b→1a) and flag before shipping.

## Open expectation

The portal preview is **stylized** — roofline dots + a soft facade glow. It approximates, and won't be 1:1 with, the photoreal wall-wash in the reference videos. Naldo signed off on this (1b, closest achievable) — device-check confirms it clears the "premium enough to sell" bar before merge.
