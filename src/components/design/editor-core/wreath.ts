import Konva from "konva";
import type { WreathItem } from "@/lib/design/sceneTypes";
import { getAssetSync, loadAsset } from "./assets";

// Wreaths render visually larger than 1:1 with the yardstick. The PNG has
// transparent padding around the greenery ring, so the visible diameter is
// smaller than the bounding box. This multiplier compensates so a "36-inch
// wreath" actually reads as ~36 inches on the photo. Bump if Jason still
// thinks they're small; lower if they go too big.
const WREATH_RENDER_SCALE = 1.8;

// A wreath renders as a PNG image (with-lights or without-lights variant).
// `sizeIn` is the real-world diameter — converted to pixels via the active
// yardstick's px/ft (and then scaled by WREATH_RENDER_SCALE) so wreaths look
// right on the photo.
export function createWreath(
  item: WreathItem,
  pxPerFoot: number,
  requestRedraw: () => void,
): Konva.Group {
  const diameterFt = item.sizeIn / 12;
  const diameterPx = Math.max(16, diameterFt * pxPerFoot * WREATH_RENDER_SCALE);

  const group = new Konva.Group({
    id: item.id,
    x: item.x,
    y: item.y,
    rotation: item.rotation ?? 0,
    name: "wreath",
    listening: true,
    draggable: true,
  });

  // Pick asset based on both withLights and withBow.
  // `withBow` defaults to true when the field is missing (older designs).
  const withBow = item.withBow ?? true;
  const assetKey = withBow
    ? (item.withLights ? "wreathbow-with-lights" : "wreathbow-without-lights")
    : (item.withLights ? "wreath-with-lights" : "wreath-without-lights");
  const img = getAssetSync(assetKey);

  if (img) {
    // Scale the image to match sizeIn. Center the image on the group's origin.
    const naturalAspect = img.naturalHeight / Math.max(1, img.naturalWidth);
    const w = diameterPx;
    const h = diameterPx * naturalAspect;
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
    // Asset not loaded — kick off a load and show a placeholder ring meanwhile.
    // When the load finishes we trigger a redraw so the user sees the real wreath.
    loadAsset(assetKey).then((loaded) => {
      if (loaded) requestRedraw();
    });
    const placeholder = new Konva.Ring({
      innerRadius: diameterPx * 0.32,
      outerRadius: diameterPx / 2,
      fill: "#1f4d29",
      stroke: "#0e2a17",
      strokeWidth: 2,
      listening: false,
    });
    group.add(placeholder);
    const label = new Konva.Text({
      text: `${assetKey}.png\nmissing`,
      fontSize: Math.max(9, diameterPx * 0.07),
      fill: "#ff8a8a",
      align: "center",
      width: diameterPx,
      x: -diameterPx / 2,
      y: -diameterPx * 0.07,
      listening: false,
    });
    group.add(label);
  }

  // Invisible full-disc hit area so the wreath is easy to click anywhere on it.
  // Sits on top so the Konva.Image (which has listening: false) doesn't shadow it.
  const hit = new Konva.Circle({
    radius: diameterPx / 2,
    fill: "rgba(0,0,0,0.001)",
    listening: true,
    name: "wreath-hit",
  });
  group.add(hit);

  return group;
}
