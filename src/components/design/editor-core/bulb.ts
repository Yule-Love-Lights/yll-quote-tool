import Konva from "konva";
import type { BulbType } from "@/lib/design/sceneTypes";
import { colorOf } from "./colors";
import { bulbDims, LIGHT_SCALE_DEFAULT } from "./lightScale";

// The real-world bulb-size table and `bulbDims` now live in `lightScale.ts` —
// a Konva-free module so the sizing math is unit-testable (same split as
// `yardstick-scale.ts`). Re-exported here so existing import sites are
// unchanged.
export { bulbDims };

export function createBulb(
  bulbType: BulbType,
  colorId: string,
  pxPerFoot: number,
  lightScale: number = LIGHT_SCALE_DEFAULT,
): Konva.Group {
  const color = colorOf(colorId);
  const { radius, glowRadius, coreSoftness } = bulbDims(bulbType, pxPerFoot, lightScale);

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
