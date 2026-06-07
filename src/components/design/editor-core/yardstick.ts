import Konva from "konva";
import type { Yardstick } from "@/lib/design/sceneTypes";

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
    stroke: isSelected ? "#ffb454" : "#4f8cff",
    strokeWidth: 2,
    strokeScaleEnabled: false,
    dash: [8, 6],
    fill: isSelected ? "rgba(255,180,84,0.14)" : "rgba(79,140,255,0.08)",
    name: "yardstick-rect",
  });

  const label = new Konva.Label({
    x: ys.width / 2,
    y: -28,
    offsetX: 50,
    listening: false,
  });
  label.add(
    new Konva.Tag({
      fill: isSelected ? "#ffb454" : "#4f8cff",
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

export function pxPerFoot(ys: Yardstick | null): number {
  if (!ys || ys.realFeet === 0) return 50; // fallback
  return ys.width / ys.realFeet;
}

export function yardstickLabel(index: number): string {
  return `Yardstick ${index + 1}`;
}
