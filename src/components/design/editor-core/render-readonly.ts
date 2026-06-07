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
  type Scene,
} from "@/lib/design/sceneTypes";
import { pxPerFoot } from "./yardstick";
import { renderStrand } from "./strand";
import { createWreath } from "./wreath";
import { createBow } from "./bow";
import { renderGarland } from "./garland";
import { createSpritzer } from "./spritzer";
import { renderText } from "./text";
import { createCustom } from "./custom";
import { createPole } from "./pole";

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
): Promise<() => void> {
  const scene = opts.scene;
  const brightness = opts.brightness ?? scene.brightness ?? 50;

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
    // Step 1 renders ALL items. (The included-flag filter for the portal
    // toggles is Step 2.)
    for (const item of scene.items) {
      let g: Konva.Group | null = null;
      if (isStrand(item)) g = renderStrand(item, ppfBound(item.yardstickId));
      else if (isWreath(item)) g = createWreath(item, ppfActive(), requestRedraw);
      else if (isBow(item)) g = createBow(item, ppfActive(), requestRedraw);
      else if (isGarland(item)) g = renderGarland(item, ppfBound(item.yardstickId), requestRedraw);
      else if (isSpritzer(item)) g = createSpritzer(item, ppfActive());
      else if (isText(item)) g = renderText(item, ppfActive());
      else if (isCustom(item)) g = createCustom(item, ppfActive(), requestRedraw);
      else if (isPole(item)) g = createPole(item, ppfActive());
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
        return () => {};
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

  return function destroy() {
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
  };
}
