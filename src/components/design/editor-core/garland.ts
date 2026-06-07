import Konva from "konva";
import type { GarlandItem } from "@/lib/design/sceneTypes";
import { getAssetSync, loadAsset } from "./assets";

// Fallback thickness (inches) for garlands that pre-date the per-item sizeIn
// field. Picked to match the prior global default (0.8 ft = ~9.6 in) so older
// designs don't visually shift.
const FALLBACK_THICKNESS_IN = 9.6;
// Overlap factor between consecutive stamps so the rope stays continuous
// without visible gaps when the path bends.
const STAMP_OVERLAP = 0.08;

// Renders a garland: a continuous greenery rope along a polyline. The chosen
// PNG variant (`garland-with-lights` / `garland-without-lights`) is stamped
// along the path, rotated to the local tangent at each stamp.
export function renderGarland(
  item: GarlandItem,
  pxPerFoot: number,
  requestRedraw: () => void,
): Konva.Group {
  const group = new Konva.Group({
    id: item.id,
    listening: true,
    name: "garland",
  });
  group.setAttr("garlandData", item);

  const assetKey = item.withLights
    ? "garland-with-lights"
    : "garland-without-lights";
  const img = getAssetSync(assetKey);
  if (!img) {
    loadAsset(assetKey).then((loaded) => {
      if (loaded) requestRedraw();
    });
  }

  // Natural aspect (width-over-height) of one PNG stamp.
  const aspect = img ? img.naturalWidth / Math.max(1, img.naturalHeight) : 4;
  const thicknessFt = (item.sizeIn ?? FALLBACK_THICKNESS_IN) / 12;
  const stampHeightPx = Math.max(8, thicknessFt * pxPerFoot);
  const stampWidthPx = stampHeightPx * aspect;
  const advancePx = stampWidthPx * (1 - STAMP_OVERLAP);

  if (item.points.length === 0) return group;

  if (item.points.length === 2) {
    // Single-stamp mode — one horizontal stamp at the point.
    addStamp(group, img, item.points[0], item.points[1], 0, stampWidthPx, stampHeightPx, assetKey);
    addHitLine(group, item.points, stampHeightPx);
    return group;
  }

  // Polyline mode — walk pairwise and stamp at fixed intervals along the path,
  // rotating each stamp to match the local tangent.
  let leftover = 0;
  for (let i = 0; i < item.points.length - 2; i += 2) {
    const x1 = item.points[i];
    const y1 = item.points[i + 1];
    const x2 = item.points[i + 2];
    const y2 = item.points[i + 3];
    const segLen = Math.hypot(x2 - x1, y2 - y1);
    if (segLen === 0) continue;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const angleDeg = (angle * 180) / Math.PI;

    let traveled = -leftover;
    while (traveled <= segLen) {
      if (traveled >= 0) {
        const t = traveled / segLen;
        const cx = x1 + (x2 - x1) * t;
        const cy = y1 + (y2 - y1) * t;
        addStamp(group, img, cx, cy, angleDeg, stampWidthPx, stampHeightPx, assetKey);
      }
      traveled += advancePx;
    }
    leftover = traveled - segLen;
  }

  // Always cap the very end of the polyline with one more stamp so the rope
  // doesn't appear to die back from the last user-clicked vertex.
  const lastX = item.points[item.points.length - 2];
  const lastY = item.points[item.points.length - 1];
  const prevX = item.points[item.points.length - 4];
  const prevY = item.points[item.points.length - 3];
  const endAngle = (Math.atan2(lastY - prevY, lastX - prevX) * 180) / Math.PI;
  addStamp(group, img, lastX, lastY, endAngle, stampWidthPx, stampHeightPx, assetKey);

  addHitLine(group, item.points, stampHeightPx);
  return group;
}

function addStamp(
  parent: Konva.Group,
  img: HTMLImageElement | null,
  cx: number,
  cy: number,
  rotationDeg: number,
  widthPx: number,
  heightPx: number,
  assetKey: string,
) {
  if (img) {
    const ki = new Konva.Image({
      image: img,
      x: cx,
      y: cy,
      width: widthPx,
      height: heightPx,
      offsetX: widthPx / 2,
      offsetY: heightPx / 2,
      rotation: rotationDeg,
      listening: false,
    });
    parent.add(ki);
  } else {
    // Asset not loaded yet — show a green dashed rectangle in its place so
    // the user can still see what they drew while the PNG is loading.
    const placeholder = new Konva.Rect({
      x: cx,
      y: cy,
      width: widthPx,
      height: heightPx,
      offsetX: widthPx / 2,
      offsetY: heightPx / 2,
      rotation: rotationDeg,
      fill: "#1f4d29",
      stroke: "#0e2a17",
      strokeWidth: 1,
      dash: [4, 3],
      listening: false,
      name: `garland-placeholder-${assetKey}`,
    });
    parent.add(placeholder);
  }
}

function addHitLine(parent: Konva.Group, points: number[], thicknessPx: number) {
  // Invisible thick line tracing the polyline so clicks anywhere along the
  // garland register as a hit on this group.
  if (points.length < 4) {
    // Single-stamp mode — give it a hit circle scaled to the stamp.
    const hit = new Konva.Circle({
      x: points[0],
      y: points[1],
      radius: thicknessPx,
      fill: "rgba(0,0,0,0.001)",
      listening: true,
      name: "garland-hit",
    });
    parent.add(hit);
    return;
  }
  const hit = new Konva.Line({
    points,
    stroke: "rgba(0,0,0,0.001)",
    strokeWidth: 1,
    hitStrokeWidth: Math.max(thicknessPx * 1.4, 24),
    lineCap: "round",
    lineJoin: "round",
    listening: true,
    name: "garland-hit",
  });
  parent.add(hit);
}

// Total polyline length in pixels (mirrors strandLengthPx).
export function garlandLengthPx(item: GarlandItem): number {
  let total = 0;
  for (let i = 0; i < item.points.length - 2; i += 2) {
    total += Math.hypot(
      item.points[i + 2] - item.points[i],
      item.points[i + 3] - item.points[i + 1],
    );
  }
  return total;
}
