import Konva from "konva";
import type { Yardstick } from "@/lib/design/sceneTypes";

// Pure scale math lives in `yardstick-scale.ts` (Konva-free, so it's
// unit-testable without the optional `canvas` dep). Re-exported here so the
// many existing `from "./yardstick"` import sites keep working unchanged.
export { yardstickMeasuredPx, pxPerFoot, yardstickLabel } from "./yardstick-scale";

export function renderYardstick(ys: Yardstick, indexLabel: string, isSelected: boolean): Konva.Group {
  const group = new Konva.Group({
    x: ys.x,
    y: ys.y,
    draggable: true,
    id: ys.id,
    name: "yardstick",
  });

  const rect = new Konva.Rect({
    width: ys.width,
    height: ys.height,
    // Gold/yellow so the yardstick box stays distinct from the blue (#4f8cff)
    // selection Transformer that overlays it when you grab it to move (#71).
    // The Transformer only draws a border + handles, so a clearly-yellow FILL
    // keeps the box AREA readable underneath. Selected = brighter stroke + more
    // opaque fill for feedback. (Tunable.)
    stroke: isSelected ? "#ffd11a" : "#e6b800",
    strokeWidth: 2,
    strokeScaleEnabled: false,
    dash: [8, 6],
    fill: isSelected ? "rgba(255,200,0,0.24)" : "rgba(255,200,0,0.12)",
    name: "yardstick-rect",
  });

  // Lifted clear of the box top so the "Yardstick · N ft" tag doesn't crowd the
  // top edge while you're placing/aligning the box (#71). (Tunable: the -44 y.)
  const label = new Konva.Label({
    x: ys.width / 2,
    y: -44,
    offsetX: 50,
    listening: false,
  });
  label.add(
    new Konva.Tag({
      fill: isSelected ? "#ffd11a" : "#e6b800",
      cornerRadius: 4,
    }),
  );
  label.add(
    new Konva.Text({
      text: `${indexLabel} · ${ys.realFeet} ft`,
      fontSize: 13,
      fontStyle: "bold",
      fill: "#0f1115",
      padding: 6,
      width: 100,
      align: "center",
    }),
  );

  group.add(rect);
  group.add(label);
  return group;
}
