import type { BulbType } from "@/lib/design/sceneTypes";

// Pure light-SIZING math, split out of `bulb.ts` so it can be unit-tested
// WITHOUT loading Konva (whose node build needs the optional `canvas`
// package). Same reason `yardstick-scale.ts` was split out of `yardstick.ts`;
// `bulb.ts` re-exports `bulbDims` so existing import sites are unchanged.
//
// WHY A SCALE KNOB EXISTS AT ALL (Naldo, 2026-08-22)
// Bulb size is `max(minPx, radiusFt * pxPerFoot)` — physically honest, and on
// a whole-house photo it renders almost invisibly small. A wide shot runs
// 10-25 px/ft, and a c9 only clears its 3 px floor at 46 px/ft, so on those
// photos EVERY c9 pins to exactly 3 px and the yardstick cannot change bulb
// size at all. Dragging the yardstick to escape the floor is not a workaround
// either: `pxPerFoot` is also what sets bulb spacing and what divides strand
// pixel length into BILLED FOOTAGE, so faking it to win a nicer picture
// silently corrupts the quote.
//
// So the presentation knob is separate from the scale knob. `lightScale` is a
// per-design multiplier on how big a light is DRAWN. It multiplies the final
// radius (after the floor, so it works in both the floored and the physical
// regime) and nothing else.
//
// MONEY SAFETY — the whole point of this module.
// `lightScale` must never reach `pxPerFoot`, bulb spacing, strand length, or
// any footage total. Bulb spacing is `spacingIn / 12 * pxPerFoot` in
// `strand.ts`; billed footage is `strandLengthPx(s) / pxPerFoot` in
// `editor.ts`. Neither expression may take this value. A design's price is
// identical at 0.5x and at 4x; only the picture changes.

export const LIGHT_SCALE_MIN = 0.5;
export const LIGHT_SCALE_MAX = 4;
export const LIGHT_SCALE_DEFAULT = 1;

// Reads a stored/edited `scene.lightScale` into a usable multiplier. Absent,
// non-numeric, NaN and Infinity all fall back to 1 (today's exact rendering),
// and real numbers clamp into range — so an old design with no field, or a
// hand-edited scene JSON, can never render at 0x (invisible lights) or at
// some absurd multiple that paints the whole photo white.
export function normalizeLightScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return LIGHT_SCALE_DEFAULT;
  return Math.min(LIGHT_SCALE_MAX, Math.max(LIGHT_SCALE_MIN, value));
}

// Real-world bulb sizes (foot units, used to scale relative to the yardstick).
// Numbers are intentionally a touch larger than real life for visibility.
const TYPE: Record<
  BulbType,
  { radiusFt: number; haloMul: number; coreSoftness: number; minPx: number }
> = {
  // Big classic Christmas bulb: visible, soft warm halo.
  c9:        { radiusFt: 0.065, haloMul: 2.6, coreSoftness: 0.5,  minPx: 3 },
  // Permanent lights have a special renderer (cone). This entry is a fallback only.
  permanent: { radiusFt: 0.035, haloMul: 2.0, coreSoftness: 0.35, minPx: 2 },
  // Mini lights: small but with a clear glow halo — visible like little stars.
  mini:      { radiusFt: 0.028, haloMul: 2.1, coreSoftness: 0.25, minPx: 1.8 },
  // Bistro / Edison-style bulbs: bigger, warmer, more pronounced halo. The
  // signature outdoor-patio / cafe look — these are 5–10× the visual weight
  // of a mini, so they need a chunky radius + big soft glow.
  bistro:    { radiusFt: 0.11,  haloMul: 3.0, coreSoftness: 0.55, minPx: 4.5 },
};

// The drawn size of a spritzer's LIGHT parts, given the spritzer's own
// rendered radius in pixels.
//
// A spritzer is a radial spray: `radiusPx` is how big the SPRAY is, which
// staff already control through the item's Small/Medium/Large size and the
// resize handles. This helper covers only the lit elements inside it, which
// had no control at all and hit the same floor as a c9 does. A 24" spritzer
// at 20 px/ft renders at radiusPx 20, so its tips compute to 0.56 px and pin
// to the 1.5 px floor, and its rays pin to their 0.6 px floor. Both are
// hairlines on a house photo.
//
// Same money rule as `bulbDims`: nothing here is priced. A spritzer bills off
// its staff-set `quoteSize`, never off anything drawn.
export function spritzerLightDims(
  radiusPx: number,
  lightScale: number = LIGHT_SCALE_DEFAULT,
) {
  const scale = normalizeLightScale(lightScale);
  const tipRadius = Math.max(1.5, radiusPx * 0.028) * scale;
  return {
    tipRadius,
    tipHaloRadius: tipRadius * 2.6,
    rayStroke: Math.max(0.6, radiusPx * 0.008) * scale,
  };
}

// The drawn size of one bulb. `lightScale` multiplies AFTER the `minPx` floor
// on purpose: on a wide house shot the floor is what's actually in force
// (see the header), so scaling before it would be swallowed whole and the
// slider would do nothing on exactly the photos it exists for. Glow is
// derived from the scaled radius, so the halo grows with the core and the
// bulb keeps its proportions at every setting.
export function bulbDims(
  bulbType: BulbType,
  pxPerFoot: number,
  lightScale: number = LIGHT_SCALE_DEFAULT,
) {
  const t = TYPE[bulbType];
  const scale = normalizeLightScale(lightScale);
  const radius = Math.max(t.minPx, t.radiusFt * pxPerFoot) * scale;
  return {
    radius,
    glowRadius: radius * t.haloMul,
    coreSoftness: t.coreSoftness,
  };
}
