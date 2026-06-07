import Konva from "konva";
import type { TextItem } from "@/lib/design/sceneTypes";
import { colorOf } from "./colors";

// The four fonts the picker exposes. Loaded by the Google Fonts <link> in
// index.html; if they haven't arrived yet the browser falls back to a serif.
// After document.fonts.ready resolves we trigger a redraw so the first paint
// uses the right typeface.
export const FONT_OPTIONS = [
  "Bebas Neue",
  "Oswald",
  "Pacifico",
  "Inter",
] as const;
export type FontFamily = (typeof FONT_OPTIONS)[number];

// Default text size when nothing else is set. 60 inches matches the largest
// wreath option per Jason — gives newly-placed text a "rooftop sign" feel
// that's resizable down via the Transformer corners.
export const DEFAULT_TEXT_SIZE_IN = 60;

// Renders a lit-up text item: a Konva.Text with a wide colored shadow that
// reads as a glow, optionally with a contrasting outline. The text sits in
// the standard drawLayer which is above the brightness tint layer — so
// darkening the photo doesn't dim the text, matching the lit-up illusion.
export function renderText(item: TextItem, pxPerFoot: number): Konva.Group {
  const color = colorOf(item.colorId);
  const heightFt = item.sizeIn / 12;
  // Konva.Text fontSize roughly equals the em-square height. Visible cap
  // height is some fraction of that, but for the lit-sign use case it's
  // close enough that we just use heightFt × pxPerFoot directly.
  const fontSize = Math.max(8, heightFt * pxPerFoot);

  const group = new Konva.Group({
    id: item.id,
    x: item.x,
    y: item.y,
    rotation: item.rotation ?? 0,
    name: "text",
    listening: true,
    draggable: true,
  });

  // Konva renders text from the top-left of its bounding box. We want the
  // group's (x, y) to be the visual center so click-to-place feels natural
  // and Transformer scaling stays centered. The actual letters are drawn
  // with offsetX/offsetY = bounding box center after measuring.
  const txt = new Konva.Text({
    text: item.text || "Text",
    fontFamily: item.fontFamily,
    fontSize,
    fill: color.hex,
    stroke: item.outline ? color.glow : undefined,
    strokeWidth: item.outline ? Math.max(1, fontSize * 0.04) : 0,
    // Glow effect — wide soft halo behind the letters in the glow tint.
    shadowColor: color.glow,
    shadowBlur: Math.max(8, fontSize * 0.45),
    shadowOpacity: 0.95,
    listening: true,
    name: "text-letters",
  });

  // Center the text on the group origin so (x, y) is the visual midpoint.
  // Konva computes width/height once fontFamily + fontSize are set.
  const w = txt.width();
  const h = txt.height();
  txt.offsetX(w / 2);
  txt.offsetY(h / 2);

  group.add(txt);

  // Invisible rectangular hit area covering the text bounding box, so clicks
  // anywhere on the bounding box (not just on stroked pixels) select the text.
  const hit = new Konva.Rect({
    x: -w / 2,
    y: -h / 2,
    width: w,
    height: h,
    fill: "rgba(0,0,0,0.001)",
    listening: true,
    name: "text-hit",
  });
  group.add(hit);

  return group;
}

// Promise that resolves once the browser confirms all our chosen fonts are
// loaded. Callers (the editor) await this on init and trigger a redraw so
// the first text paint uses the right typeface instead of the default serif.
export function fontsReady(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  return document.fonts.ready.then(() => undefined);
}
