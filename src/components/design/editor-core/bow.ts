import Konva from "konva";
import type { BowItem } from "@/lib/design/sceneTypes";
import { getAssetSync, loadAsset } from "./assets";

// Renders a bow as an image scaled to `sizeIn` (width in inches). Single
// variant for now (whatever's at /items/bow.png).
export function createBow(
  item: BowItem,
  pxPerFoot: number,
  requestRedraw: () => void,
): Konva.Group {
  const widthFt = item.sizeIn / 12;
  const widthPx = Math.max(12, widthFt * pxPerFoot);

  const group = new Konva.Group({
    id: item.id,
    x: item.x,
    y: item.y,
    rotation: item.rotation ?? 0,
    name: "bow",
    listening: true,
    draggable: true,
  });

  const img = getAssetSync("bow");
  if (img) {
    const aspect = img.naturalHeight / Math.max(1, img.naturalWidth);
    const w = widthPx;
    const h = widthPx * aspect;
    const ki = new Konva.Image({
      image: img,
      width: w,
      height: h,
      x: -w / 2,
      y: -h / 2,
      listening: false,
    });
    group.add(ki);
  } else {
    // Placeholder while loading / when the asset is missing.
    loadAsset("bow").then((loaded) => {
      if (loaded) requestRedraw();
    });
    const placeholder = new Konva.Rect({
      width: widthPx * 0.9,
      height: widthPx * 0.9,
      x: -widthPx * 0.45,
      y: -widthPx * 0.45,
      fill: "#5e1c1f",
      stroke: "#8a8a45",
      strokeWidth: 2,
      cornerRadius: 6,
      listening: false,
    });
    group.add(placeholder);
    const label = new Konva.Text({
      text: "bow.png\nmissing",
      fontSize: Math.max(9, widthPx * 0.08),
      fill: "#ffd0d0",
      align: "center",
      width: widthPx * 0.9,
      x: -widthPx * 0.45,
      y: -widthPx * 0.1,
      listening: false,
    });
    group.add(label);
  }

  // Invisible hit area covering roughly the full bow footprint.
  const hit = new Konva.Rect({
    width: widthPx,
    height: widthPx, // generous square hit area regardless of natural aspect
    x: -widthPx / 2,
    y: -widthPx / 2,
    fill: "rgba(0,0,0,0.001)",
    listening: true,
    name: "bow-hit",
  });
  group.add(hit);

  return group;
}
