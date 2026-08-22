import Konva from "konva";
import {
  isStrand,
  isWreath,
  isBow,
  isGarland,
  isSpritzer,
  isText,
  isCustom,
  isPole,
  isMiniArea,
  type Scene,
} from "@/lib/design/sceneTypes";
import { pxPerFoot } from "./yardstick";
import { renderStrand } from "./strand";
import { normalizeLightScale } from "./lightScale";
import { createWreath } from "./wreath";
import { createBow } from "./bow";
import { renderGarland } from "./garland";
import { createSpritzer } from "./spritzer";
import { renderText } from "./text";
import { createCustom } from "./custom";
import { createPole } from "./pole";
import { renderMiniArea } from "./miniArea";

// Read-only render of a design scene onto its photo (design-tool integration
// #27 Phase 2 — Step 1: the live portal hero). This is a stripped-down sibling
// of the editor's render pipeline: same per-item renderers + photo-fit + tint,
// but NO sidebar, NO transformer, NO selection, NO interaction. So the portal
// render matches exactly what the operator drew, without any editing surface.
//
// Mounts a Konva stage into `host`, fits the photo to the host, renders every
// scene item, applies the brightness tint, and stays responsive (refits on
// resize). Returns a destroy() the caller runs on unmount.

export type ReadOnlyDesignOptions = {
  scene: Scene;
  photoUrl: string | null;
  photoW: number | null;
  photoH: number | null;
  /** Overrides scene.brightness if provided. */
  brightness?: number;
  /**
   * Overrides scene.lightScale if provided — how big the lights are DRAWN
   * (0.5–4, default 1). Presentation only; it never touches footage or price.
   * Normally left unset so the portal shows exactly the size staff set in the
   * editor.
   */
  lightScale?: number;
  /**
   * Scene-item ids to HIDE (#27 D — portal toggle filter). null/undefined ⇒
   * render everything. Update live without remounting via the returned setHidden.
   */
  hiddenIds?: Set<string> | null;
  /**
   * Whole-house light color/pattern OVERRIDE (#10 customer color picker, #92
   * pattern-aware): a PER-ITEM map of sceneItemId → the palette color ids that
   * item recolors to (one solid, a real strand's colors, or the full cycle for
   * roofline). Computed app-layer (DesignCanvas) so each item shows exactly what
   * we'd install. null/undefined ⇒ no override (render the operator's authored
   * per-item colors). Update live via setColorOverride.
   */
  colorOverride?: Map<string, string[]> | null;
};

// Handle returned to the React wrapper: tear down, or update the hidden set /
// color override in place (re-renders only the draw layer — no photo reload /
// no flicker).
export type ReadOnlyDesignController = {
  destroy: () => void;
  setHidden: (ids: Set<string> | null) => void;
  setColorOverride: (map: Map<string, string[]> | null) => void;
};

function loadHTMLImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

export async function renderReadOnlyDesign(
  host: HTMLDivElement,
  opts: ReadOnlyDesignOptions,
): Promise<ReadOnlyDesignController> {
  const scene = opts.scene;
  const brightness = opts.brightness ?? scene.brightness ?? 50;
  const lightScale = normalizeLightScale(opts.lightScale ?? scene.lightScale);
  // Mutable so the React wrapper can update the toggle filter without remounting.
  let hidden: Set<string> | null = opts.hiddenIds ?? null;
  // Mutable per-item color override (#10/#92). null ⇒ render as authored.
  let colorOverride: Map<string, string[]> | null =
    opts.colorOverride && opts.colorOverride.size > 0 ? opts.colorOverride : null;

  // Konva clears its container on mount; `host` is a dedicated, empty div.
  const stage = new Konva.Stage({
    container: host,
    width: host.clientWidth || 1,
    height: host.clientHeight || 1,
  });
  const bgLayer = new Konva.Layer({ listening: false });
  const tintLayer = new Konva.Layer({ listening: false });
  const drawLayer = new Konva.Layer({ listening: false });
  stage.add(bgLayer);
  stage.add(tintLayer);
  stage.add(drawLayer);

  let bgImageNode: Konva.Image | null = null;
  let tintRect: Konva.Rect | null = null;
  let photoW = opts.photoW ?? 0;
  let photoH = opts.photoH ?? 0;

  // Pixels-per-foot helpers (mirror the editor): strands + garlands use their
  // own bound yardstick; everything else uses the first ("active") yardstick.
  // pxPerFoot() falls back to 50 when there's no yardstick.
  const firstYs = () => scene.yardsticks[0] ?? null;
  const ppfActive = () => pxPerFoot(firstYs());
  const ppfBound = (yardstickId: string | null) =>
    pxPerFoot(
      (yardstickId ? scene.yardsticks.find((y) => y.id === yardstickId) : null) ?? firstYs(),
    );

  function applyTransform() {
    const cw = host.clientWidth || 1;
    const ch = host.clientHeight || 1;
    const w = photoW || bgImageNode?.width() || cw;
    const h = photoH || bgImageNode?.height() || ch;
    // Cover-fit (fill the hero, crop the overflow) so the live design fills the
    // screen exactly like the daytime photo's `object-cover`. (The editor uses
    // contain-fit to show the whole photo while designing; the portal fills.)
    const fitScale = Math.max(cw / w, ch / h);
    const offset = { x: (cw - w * fitScale) / 2, y: (ch - h * fitScale) / 2 };
    stage.size({ width: cw, height: ch });
    const s = { x: fitScale, y: fitScale };
    bgLayer.position(offset).scale(s);
    tintLayer.position(offset).scale(s);
    drawLayer.position(offset).scale(s);
    bgLayer.batchDraw();
    tintLayer.batchDraw();
    drawLayer.batchDraw();
  }

  function drawTint() {
    tintRect?.destroy();
    tintRect = null;
    const w = photoW || bgImageNode?.width() || 0;
    const h = photoH || bgImageNode?.height() || 0;
    if (brightness === 50 || !w || !h) {
      tintLayer.batchDraw();
      return;
    }
    let fill: string;
    if (brightness < 50) {
      const t = (50 - brightness) / 50;
      const a = Math.pow(t, 0.9) * 0.94;
      fill = `rgba(0,4,12,${a})`;
    } else {
      const a = ((brightness - 50) / 50) * 0.25;
      fill = `rgba(255,250,235,${a})`;
    }
    tintRect = new Konva.Rect({ width: w, height: h, fill, listening: false });
    tintLayer.add(tintRect);
    tintLayer.batchDraw();
  }

  let destroyed = false;
  let redrawHandle = 0;
  // Image-backed renderers (wreath/bow/garland/custom) call this when their
  // async images finish loading; re-render to swap the placeholder for the art.
  function requestRedraw() {
    if (redrawHandle || destroyed) return;
    redrawHandle = requestAnimationFrame(() => {
      redrawHandle = 0;
      renderItems();
    });
  }

  function renderItems() {
    if (destroyed) return;
    drawLayer.destroyChildren();
    // Render every scene item EXCEPT those hidden by the portal toggle filter
    // (#27 D). Items with no controlling line item are never in `hidden`, so
    // they always render.
    for (const item of scene.items) {
      if (hidden && hidden.has(item.id)) continue;
      // #92 — the per-item override colors for this item (a real strand's colors,
      // a single solid, or the full cycle for roofline), or null = render authored.
      const cp = colorOverride?.get(item.id) ?? null;
      let g: Konva.Group | null = null;
      // Light items (strand, spritzer, mini-area) recolor to the whole-house
      // override (#10/#92) by swapping their colorPattern — a shallow clone so the
      // stored scene is never mutated. Non-light items ignore the override.
      if (isStrand(item)) g = renderStrand(cp ? { ...item, colorPattern: cp } : item, ppfBound(item.yardstickId), lightScale);
      else if (isWreath(item)) g = createWreath(item, ppfActive(), requestRedraw);
      else if (isBow(item)) g = createBow(item, ppfActive(), requestRedraw);
      else if (isGarland(item)) g = renderGarland(item, ppfBound(item.yardstickId), requestRedraw);
      else if (isSpritzer(item)) g = createSpritzer(cp ? { ...item, colorPattern: cp } : item, ppfActive(), lightScale);
      else if (isText(item)) g = renderText(item, ppfActive());
      else if (isCustom(item)) g = createCustom(item, ppfActive(), requestRedraw);
      else if (isPole(item)) g = createPole(item, ppfActive());
      // A2 Mini-Area scatter-fill (bushes/canopy). Uses its bound yardstick like
      // strands (the fill density is area/scale-dependent). miniGroup has no
      // geometry — its member strands render on their own.
      else if (isMiniArea(item)) g = renderMiniArea(cp ? { ...item, colorPattern: cp } : item, ppfBound(item.yardstickId), lightScale);
      if (g) {
        g.listening(false);
        drawLayer.add(g);
      }
    }
    drawLayer.batchDraw();
  }

  if (opts.photoUrl) {
    try {
      const img = await loadHTMLImage(opts.photoUrl);
      if (destroyed) {
        try {
          stage.destroy();
        } catch {
          /* gone */
        }
        return { destroy: () => {}, setHidden: () => {}, setColorOverride: () => {} };
      }
      photoW = photoW || img.naturalWidth;
      photoH = photoH || img.naturalHeight;
      bgImageNode = new Konva.Image({ image: img, width: photoW, height: photoH, listening: false });
      bgLayer.add(bgImageNode);
    } catch {
      // No photo — still render the items on a blank stage.
    }
  }

  applyTransform();
  drawTint();
  renderItems();

  // Stay responsive: refit when the host resizes (the hero is full-viewport).
  const refit = () => {
    if (destroyed) return;
    applyTransform();
    drawTint();
  };
  const ro = new ResizeObserver(refit);
  ro.observe(host);
  window.addEventListener("resize", refit);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    ro.disconnect();
    window.removeEventListener("resize", refit);
    if (redrawHandle) cancelAnimationFrame(redrawHandle);
    try {
      stage.destroy();
    } catch {
      /* already gone */
    }
  }

  // Update the hidden set live (portal toggle) — re-render the draw layer only.
  function setHidden(ids: Set<string> | null) {
    if (destroyed) return;
    hidden = ids;
    renderItems();
  }

  // Update the whole-house color override live (#10 color picker) — re-render the
  // draw layer only (no photo reload / flicker), exactly like setHidden.
  function setColorOverride(map: Map<string, string[]> | null) {
    if (destroyed) return;
    colorOverride = map && map.size > 0 ? map : null;
    renderItems();
  }

  return { destroy, setHidden, setColorOverride };
}
