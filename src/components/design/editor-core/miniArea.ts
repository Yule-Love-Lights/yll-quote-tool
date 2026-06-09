import Konva from "konva";
// VENDOR ADAPTATION (Path B): type from our local sceneTypes, not ../api.
// Byte-identical with the design tool's canonical editor/miniArea.ts otherwise.
import type { MiniAreaItem } from "@/lib/design/sceneTypes";

// Renders a MiniAreaItem: a box or traced polygon "filled" with deterministically
// scattered single mini-lights, blended onto the photo with `lighten` so it reads
// like real mini-light coverage on a bush/canopy. Standalone renderer (its own
// file, like the other item renderers) so both the editor and the quote tool's
// read-only portal renderer can use it.
//
// `density` (0–1) is VISUAL ONLY — it sets bulbs-per-real-world-area so the fill
// looks consistent at any size; it never affects price (the billed quantity is
// the staff-set `stringCount`). Scatter is seeded by the item id so a given area
// renders identically across reloads / undo.
//
// Coordinate convention: the returned Group is positioned at the area's origin
// (box top-left, or the polygon's bounding-box min) and all children are drawn in
// LOCAL coordinates relative to that origin — so dragging the Group moves the
// area and the editor can bake group.x/y back into the item geometry.

const FILL_K = 6;          // bulbs per real-world sq ft at density = 1
const MIN_BULBS = 4;
const MAX_BULBS = 600;     // perf guard for huge / dense areas
const MINI_HEX = "#fff2d4";    // warm-white mini glow
const MINI_CORE = "#fffdf5";

export function renderMiniArea(item: MiniAreaItem, pxPerFoot: number): Konva.Group {
  // Resolve the shape into LOCAL polygon points + an origin (so the group can
  // sit at the origin and children are relative to it).
  const { originX, originY, local, widthPx, heightPx } = resolveShape(item);

  const group = new Konva.Group({
    id: item.id,
    x: originX,
    y: originY,
    name: "miniArea",
    listening: true,
  });

  const areaFt2 = polygonAreaPx(local) / (pxPerFoot * pxPerFoot);
  const density = clamp(item.density ?? 0.5, 0, 1);
  const count = clamp(Math.round(density * areaFt2 * FILL_K), MIN_BULBS, MAX_BULBS);

  const rPx = Math.max(1.2, 0.09 * pxPerFoot);   // mini bulb core radius
  const haloPx = rPx * 2.6;

  // Faint dashed outline so the area is visible even when sparsely filled / empty.
  const outline = new Konva.Line({
    points: local.concat([local[0], local[1]]),
    stroke: "rgba(255,255,255,0.18)",
    strokeWidth: 1,
    dash: [5, 4],
    closed: false,
    listening: false,
  });
  group.add(outline);

  // Scatter bulbs (rejection-sampled inside the polygon for non-box shapes).
  const rng = makeRng(item.id);
  const [minX, minY, maxX, maxY] = bbox(local);
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 12 + 50;
  while (placed < count && attempts < maxAttempts) {
    attempts++;
    const lx = minX + rng() * (maxX - minX);
    const ly = minY + rng() * (maxY - minY);
    if (item.shape === "polygon" && !pointInPolygon(lx, ly, local)) continue;
    // Soft halo (lighten).
    group.add(
      new Konva.Circle({
        x: lx,
        y: ly,
        radius: haloPx,
        fillRadialGradientStartPoint: { x: 0, y: 0 },
        fillRadialGradientStartRadius: 0,
        fillRadialGradientEndPoint: { x: 0, y: 0 },
        fillRadialGradientEndRadius: haloPx,
        fillRadialGradientColorStops: [0, hexA(MINI_HEX, 0.8), 0.4, hexA(MINI_HEX, 0.35), 1, hexA(MINI_HEX, 0)],
        globalCompositeOperation: "lighten",
        listening: false,
      }),
    );
    // Crisp core.
    group.add(
      new Konva.Circle({
        x: lx,
        y: ly,
        radius: rPx,
        fillRadialGradientStartPoint: { x: 0, y: 0 },
        fillRadialGradientStartRadius: 0,
        fillRadialGradientEndPoint: { x: 0, y: 0 },
        fillRadialGradientEndRadius: rPx,
        fillRadialGradientColorStops: [0, MINI_CORE, 0.6, MINI_HEX, 1, hexA(MINI_HEX, 0.2)],
        listening: false,
      }),
    );
    placed++;
  }

  // Invisible fill on TOP so clicks anywhere inside the area select/drag this
  // group (mirrors the spritzer hit shape; added last = topmost hit target).
  const hit =
    item.shape === "polygon"
      ? new Konva.Line({ points: local, closed: true, fill: "rgba(0,0,0,0.001)", listening: true, name: "miniArea-hit" })
      : new Konva.Rect({ x: 0, y: 0, width: widthPx, height: heightPx, fill: "rgba(0,0,0,0.001)", listening: true, name: "miniArea-hit" });
  group.add(hit);

  // Stash the rendered px size so the editor can build a keep-fit Transformer
  // bounding box for box-shaped areas.
  group.setAttr("areaWidthPx", widthPx);
  group.setAttr("areaHeightPx", heightPx);
  return group;
}

// ----- shape helpers -----

function resolveShape(item: MiniAreaItem): {
  originX: number;
  originY: number;
  local: number[];
  widthPx: number;
  heightPx: number;
} {
  if (item.shape === "polygon" && item.points && item.points.length >= 6) {
    const pts = item.points;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    }
    const local: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      local.push(pts[i] - minX, pts[i + 1] - minY);
    }
    return { originX: minX, originY: minY, local, widthPx: maxX - minX, heightPx: maxY - minY };
  }
  // box (default)
  const x = item.x ?? 0, y = item.y ?? 0;
  const w = Math.max(1, item.width ?? 0), h = Math.max(1, item.height ?? 0);
  return { originX: x, originY: y, local: [0, 0, w, 0, w, h, 0, h], widthPx: w, heightPx: h };
}

function bbox(local: number[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < local.length; i += 2) {
    minX = Math.min(minX, local[i]); maxX = Math.max(maxX, local[i]);
    minY = Math.min(minY, local[i + 1]); maxY = Math.max(maxY, local[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

function polygonAreaPx(local: number[]): number {
  let a = 0;
  const n = local.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = local[i * 2], y1 = local[i * 2 + 1];
    const x2 = local[((i + 1) % n) * 2], y2 = local[((i + 1) % n) * 2 + 1];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function pointInPolygon(x: number, y: number, local: number[]): boolean {
  let inside = false;
  const n = local.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = local[i * 2], yi = local[i * 2 + 1];
    const xj = local[j * 2], yj = local[j * 2 + 1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Deterministic 0..1 PRNG seeded by the item id (same approach as the spritzer
// renderer) so a given area scatters identically every render.
function makeRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
