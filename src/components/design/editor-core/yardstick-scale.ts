import type { Yardstick } from "@/lib/design/sceneTypes";

// Pure scale math for the yardstick, split out from `yardstick.ts` so it can be
// unit-tested WITHOUT loading Konva (whose node build needs the optional
// `canvas` package). `yardstick.ts` re-exports these so existing import sites
// are unchanged.

// The pixel extent the operator's `realFeet` measures along. The yardstick is a
// drawn BOX, but `realFeet` refers to ONE side of it (the one the operator
// dragged along the real-world feature). `axis` records which side:
//   - "width"  → horizontal references (a door's width, a garage door)
//   - "height" → vertical references (a downspout, column, garage-door HEIGHT)
// Legacy yardsticks (and design-tool data) have no `axis`; they default to
// "width" so their scale is unchanged. NOT `Math.max(width,height)`: a "3 ft
// wide" door drawn 3 ft wide × 7 ft tall must keep measuring the 3-ft width,
// and max() would wrongly pick the 7-ft height.
export function yardstickMeasuredPx(ys: Yardstick): number {
  return ys.axis === "height" ? ys.height : ys.width;
}

export function pxPerFoot(ys: Yardstick | null): number {
  if (!ys || ys.realFeet === 0) return 50; // fallback
  return yardstickMeasuredPx(ys) / ys.realFeet;
}

export function yardstickLabel(index: number): string {
  return `Yardstick ${index + 1}`;
}
