import Konva from "konva";
import type { BulbType } from "@/lib/design/sceneTypes";
import { colorOf } from "./colors";

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

export function bulbDims(bulbType: BulbType, pxPerFoot: number) {
  const t = TYPE[bulbType];
  const radius = Math.max(t.minPx, t.radiusFt * pxPerFoot);
  return {
    radius,
    glowRadius: radius * t.haloMul,
    coreSoftness: t.coreSoftness,
  };
}

export function createBulb(
  bulbType: BulbType,
  colorId: string,
  pxPerFoot: number,
): Konva.Group {
  const color = colorOf(colorId);
  const { radius, glowRadius, coreSoftness } = bulbDims(bulbType, pxPerFoot);

  const group = new Konva.Group({ listening: false });

  // Soft halo — sits in the lighten layer so it brightens the photo behind it.
  // Stronger center, smooth falloff to transparent for that "warm Christmas light" look.
  const halo = new Konva.Circle({
    radius: glowRadius,
    fillRadialGradientStartPoint: { x: 0, y: 0 },
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndPoint: { x: 0, y: 0 },
    fillRadialGradientEndRadius: glowRadius,
    fillRadialGradientColorStops: [
      0, hexA(color.hex, 0.85),
      0.3, hexA(color.hex, 0.45),
      0.7, hexA(color.hex, 0.12),
      1, hexA(color.hex, 0),
    ],
    globalCompositeOperation: "lighten",
    listening: false,
  });

  // Crisp opaque bulb core — like a real LED. No blend mode, so it stays bright and sharp.
  // Center is the lightest "glow" tint, edge is the saturated color.
  const core = new Konva.Circle({
    radius,
    fillRadialGradientStartPoint: { x: 0, y: 0 },
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndPoint: { x: 0, y: 0 },
    fillRadialGradientEndRadius: radius,
    fillRadialGradientColorStops: [
      0, color.glow,
      coreSoftness, color.glow,
      0.85, color.hex,
      1, darken(color.hex, 0.25),
    ],
    listening: false,
  });

  group.add(halo);
  group.add(core);
  return group;
}

function hexA(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function darken(hex: string, amount: number) {
  const h = hex.replace("#", "");
  const r = Math.round(parseInt(h.slice(0, 2), 16) * (1 - amount));
  const g = Math.round(parseInt(h.slice(2, 4), 16) * (1 - amount));
  const b = Math.round(parseInt(h.slice(4, 6), 16) * (1 - amount));
  return `rgb(${r},${g},${b})`;
}
