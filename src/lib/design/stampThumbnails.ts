// #13 linked twins x #240 mini groups (Jason's ruling on item 2(b) of the
// twin-group-stamp-and-ordinals fix round): "which 'column minis' is the
// first column in photo 1?" is really a question about SEEING the item, not
// reading its number — the number is only a proxy. This module computes the
// PURE geometry (a crop box, in the item's own photo-pixel space) that
// editor.ts crops a small thumbnail image from. No Konva/DOM here, so it's
// unit-testable; the actual image load + canvas crop lives in
// editor-core/stampThumbnail.ts (impure, same Konva-free-test-env
// constraint as the rest of editor.ts).

import type { SceneItem } from './sceneTypes';
import { isWreath, isBow, isGarland, isSpritzer, isMiniArea, isMiniGroup, isStrand } from './sceneTypes';

export type ThumbBox = { x: number; y: number; w: number; h: number };

// Padding around each kind's own geometry, in the item's photo-pixel space.
// These are deliberately generous FIXED values rather than derived from a
// yardstick's px/ft (sizeIn is a REAL-WORLD inches value, not pixels, and
// pulling in the yardstick-scale machinery just to size a crop box is more
// coupling than a thumbnail needs) — a bit of extra background around the
// item is harmless for a small preview image.
const POINT_PAD = 24; // a drawn line/polygon (strand, garland, miniArea polygon)
const ANCHOR_PAD = 60; // a point-anchored item (wreath, bow, spritzer)
const AREA_PAD = 8; // a box-shaped miniArea (already has real width/height)

function boundsOfPoints(points: number[] | undefined): ThumbBox | null {
  if (!Array.isArray(points) || points.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k + 1 < points.length; k += 2) {
    const x = points[k], y = points[k + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function pad(box: ThumbBox, amount: number): ThumbBox {
  return { x: box.x - amount, y: box.y - amount, w: box.w + amount * 2, h: box.h + amount * 2 };
}

function union(a: ThumbBox, b: ThumbBox): ThumbBox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The crop box for ONE item, in its own photo's pixel space. `allItems` is
// only needed for a MiniGroupItem (to resolve its live members) — omit it
// for any other kind. Returns null when there's nothing computable (a
// group with zero live members, a polygon with no points, an unmapped
// kind) so the caller can degrade to the numbered text label instead of a
// broken image.
export function itemThumbnailBBox(item: SceneItem, allItems: SceneItem[] = []): ThumbBox | null {
  if (isWreath(item) || isBow(item) || isSpritzer(item)) {
    return { x: item.x - ANCHOR_PAD, y: item.y - ANCHOR_PAD, w: ANCHOR_PAD * 2, h: ANCHOR_PAD * 2 };
  }
  if (isGarland(item) || isStrand(item)) {
    const b = boundsOfPoints(item.points);
    return b ? pad(b, POINT_PAD) : null;
  }
  if (isMiniArea(item)) {
    if (item.shape === 'box') {
      if (typeof item.x !== 'number' || typeof item.y !== 'number' || typeof item.width !== 'number' || typeof item.height !== 'number') return null;
      return { x: item.x - AREA_PAD, y: item.y - AREA_PAD, w: item.width + AREA_PAD * 2, h: item.height + AREA_PAD * 2 };
    }
    const b = boundsOfPoints(item.points);
    return b ? pad(b, POINT_PAD) : null;
  }
  if (isMiniGroup(item)) {
    const memberIds = new Set(item.memberIds);
    const members = allItems.filter(
      (i) => memberIds.has(i.id) && (isStrand(i) || isMiniArea(i)) && i.groupId === item.id,
    );
    let box: ThumbBox | null = null;
    for (const member of members) {
      const memberBox = itemThumbnailBBox(member, allItems);
      if (!memberBox) continue;
      box = box ? union(box, memberBox) : memberBox;
    }
    return box;
  }
  // text / custom / pole / permanent — never stampable candidates anyway.
  return null;
}
