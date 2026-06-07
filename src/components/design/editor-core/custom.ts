import Konva from "konva";
import type { CustomItem } from "@/lib/design/sceneTypes";

// In-memory cache so the same imagePath doesn't get re-fetched for every
// redraw. Maps imagePath → HTMLImageElement once loaded.
const cache: Map<string, HTMLImageElement> = new Map();
const loading: Map<string, Promise<HTMLImageElement | null>> = new Map();

function loadImg(url: string): Promise<HTMLImageElement | null> {
  const cached = cache.get(url);
  if (cached) return Promise.resolve(cached);
  const inflight = loading.get(url);
  if (inflight) return inflight;
  const p = new Promise<HTMLImageElement | null>((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      cache.set(url, img);
      loading.delete(url);
      res(img);
    };
    img.onerror = () => {
      loading.delete(url);
      res(null);
    };
    img.src = url;
  });
  loading.set(url, p);
  return p;
}

// Renders a user-uploaded graphic at (x, y) (its center). Falls back to a
// labeled placeholder rectangle while the image loads (and triggers a redraw
// via `requestRedraw` when the load finishes).
//
// When `autoHalo` is true, a heavily-blurred copy of the same image is drawn
// underneath the main image with `globalCompositeOperation: "lighten"`. This
// gives a soft glow around any bright pixels — works for any image without
// needing pixel-level analysis.
export function createCustom(
  item: CustomItem,
  pxPerFoot: number,
  requestRedraw: () => void,
): Konva.Group {
  const url = `/photos/${item.imagePath}`;

  const group = new Konva.Group({
    id: item.id,
    x: item.x,
    y: item.y,
    rotation: item.rotation ?? 0,
    name: "custom",
    listening: true,
    draggable: true,
  });

  const widthFt = item.widthIn / 12;
  const widthPx = Math.max(20, widthFt * pxPerFoot);

  const img = cache.get(url);
  if (img) {
    const aspect = img.naturalHeight / Math.max(1, img.naturalWidth);
    const w = widthPx;
    const h = widthPx * aspect;
    const sx = item.flipH ? -1 : 1;
    const sy = item.flipV ? -1 : 1;

    if (item.autoHalo) {
      // Halo: same image, scaled slightly larger, blurred heavily, lighten-
      // composited. Konva's Blur filter requires the node to be cached so it
      // can render to an offscreen canvas first — that's what `.cache()` does.
      const haloW = w * 1.15;
      const haloH = h * 1.15;
      const halo = new Konva.Image({
        image: img,
        width: haloW,
        height: haloH,
        x: (-haloW / 2) * sx,
        y: (-haloH / 2) * sy,
        scaleX: sx,
        scaleY: sy,
        opacity: 0.9,
        globalCompositeOperation: "lighten",
        listening: false,
      });
      halo.filters([Konva.Filters.Blur]);
      halo.blurRadius(Math.max(6, widthPx * 0.05));
      halo.cache();
      group.add(halo);
    }

    const ki = new Konva.Image({
      image: img,
      width: w,
      height: h,
      x: (-w / 2) * sx,
      y: (-h / 2) * sy,
      scaleX: sx,
      scaleY: sy,
      listening: false,
    });
    group.add(ki);

    // Invisible rect covering the bounding box so the whole footprint is
    // clickable even on a sparse PNG (e.g., text-only graphic).
    const hit = new Konva.Rect({
      x: -w / 2,
      y: -h / 2,
      width: w,
      height: h,
      fill: "rgba(0,0,0,0.001)",
      listening: true,
      name: "custom-hit",
    });
    group.add(hit);
  } else {
    // Kick off the load; redraw the layer when it arrives.
    loadImg(url).then((loaded) => {
      if (loaded) requestRedraw();
    });
    // Placeholder rectangle so the item is visible / clickable / draggable
    // while the bytes are en route.
    const placeholder = new Konva.Rect({
      x: -widthPx / 2,
      y: -widthPx / 4,
      width: widthPx,
      height: widthPx / 2,
      fill: "#2a2a3a",
      stroke: "#4f8cff",
      strokeWidth: 2,
      dash: [6, 4],
      cornerRadius: 6,
      listening: true,
      name: "custom-hit",
    });
    group.add(placeholder);
    const label = new Konva.Text({
      text: "loading…",
      fontSize: Math.max(10, widthPx * 0.08),
      fill: "#9bb3e0",
      width: widthPx,
      x: -widthPx / 2,
      y: -widthPx * 0.04,
      align: "center",
      listening: false,
    });
    group.add(label);
  }

  return group;
}
