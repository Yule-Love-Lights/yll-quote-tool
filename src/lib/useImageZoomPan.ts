'use client';

// Scroll-wheel zoom + drag-to-pan for a measurement image box (#26).
//
// The measurement boxes (quote/new Satellite tab, /training/new photo markup)
// are an <img> + SVG overlay + absolutely-positioned point handles, all sharing
// one element whose getBoundingClientRect() drives the normalized-coordinate
// drag math. This hook adds zoom/pan by applying a CSS transform to THAT SAME
// element, so the existing pointer math stays correct with zero handler changes
// (the rect it reads already reflects the transform).
//
// Wiring (per box) — the consumer owns BOTH refs and passes the outer one in:
//   const wrapperRef = useRef<HTMLDivElement>(null);
//   const zp = useImageZoomPan(wrapperRef, { disabled: addingPoints });
//   <div ref={wrapperRef} className="relative w-full overflow-hidden" {...zp.panHandlers}>
//     <div ref={coordEl} style={zp.transformStyle} onClick={...}> <img/> <svg/> {handles} </div>
//   </div>
// Point handles must call e.stopPropagation() on pointer-down so grabbing a
// handle never starts a pan.
//
// Conventions: transform-origin is the top-left (0,0); transform is
// `translate(panX,panY) scale(zoom)` ⇒ a stored 0–1 point renders at
// panX + zoom*(p*size). Pan is in screen px. Pan is clamped so the (scaled)
// image always fills the box — no empty gutters — which also forces pan to 0 at
// zoom 1.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';

export type ZoomPanOptions = {
  /** Minimum zoom (fit). Default 1 — never zoom out past the natural fit. */
  min?: number;
  /** Maximum zoom. Default 4. */
  max?: number;
  /** When true, wheel-zoom and pan-start are ignored (e.g. while adding points). */
  disabled?: boolean;
};

export type ZoomPanState = {
  zoom: number;
  panX: number;
  panY: number;
};

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

export function clampZoom(z: number, min: number, max: number): number {
  if (Number.isNaN(z)) return min;
  return Math.min(max, Math.max(min, z));
}

// Clamp pan so the scaled content always covers the box (size = box width/height
// along the axis). Scaled content is `zoom*size`; valid offset is [size - zoom*size, 0]
// = [size*(1-zoom), 0]. At zoom 1 that collapses to 0.
export function clampPan(pan: number, zoom: number, size: number): number {
  if (!Number.isFinite(pan) || size <= 0) return 0;
  const minPan = size * (1 - zoom); // ≤ 0
  return Math.min(0, Math.max(minPan, pan));
}

// New pan that keeps the content point currently under the cursor fixed while
// zoom changes prev→next. cursor is measured from the box's top-left (0,0).
//   local = (cursor - prevPan) / prevZoom ; nextPan = cursor - nextZoom*local
export function anchorPan(
  cursor: number,
  prevPan: number,
  prevZoom: number,
  nextZoom: number,
): number {
  if (prevZoom <= 0) return prevPan;
  const local = (cursor - prevPan) / prevZoom;
  return cursor - nextZoom * local;
}

// ── Hook ────────────────────────────────────────────────────────────────────

// The consumer owns the OUTER element's ref (the standard useRef + custom-hook
// pattern) and passes it in; the hook returns ONLY plain values + handlers (no
// ref), so reading them during render is clean under react-hooks/refs.
export function useImageZoomPan(
  wrapperRef: RefObject<HTMLDivElement | null>,
  opts: ZoomPanOptions = {},
) {
  const min = opts.min ?? 1;
  const max = opts.max ?? 4;
  const disabled = opts.disabled ?? false;

  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);

  // Mirrors of state/options, written in an effect (not during render), so the
  // wheel + pan handlers always read the latest values without re-subscribing.
  const stateRef = useRef<ZoomPanState>({ zoom, panX, panY });
  const cfgRef = useRef({ min, max, disabled });
  useEffect(() => {
    stateRef.current = { zoom, panX, panY };
    cfgRef.current = { min, max, disabled };
  });

  const reset = useCallback(() => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, []);

  // Wheel = zoom toward the cursor. Native listener with { passive: false } so
  // preventDefault() actually stops the page from scrolling (React's onWheel can
  // be passive and would no-op the preventDefault).
  //
  // NO dep array — runs after every render — because the measurement box is
  // CONDITIONALLY rendered (only once a photo loads). A [wrapperRef] effect would
  // run once at mount when wrapperRef.current is still null and never re-attach
  // when the box appears. Re-binding each render is cheap (one remove + add).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (cfgRef.current.disabled) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const { zoom: z0, panX: px0, panY: py0 } = stateRef.current;
      // Smooth, magnitude-aware step; scroll up (deltaY<0) zooms in.
      const z1 = clampZoom(z0 * Math.exp(-e.deltaY * 0.0015), cfgRef.current.min, cfgRef.current.max);
      if (z1 === z0) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setZoom(z1);
      setPanX(clampPan(anchorPan(cx, px0, z0, z1), z1, rect.width));
      setPanY(clampPan(anchorPan(cy, py0, z0, z1), z1, rect.height));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // Drag the background to pan. Point handles call stopPropagation so this never
  // fires when grabbing a point. Window listeners (like the point-drag) so the
  // gesture continues outside the box.
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (cfgRef.current.disabled) return;
      if (stateRef.current.zoom <= cfgRef.current.min) return; // nothing to pan at fit
      const startX = e.clientX;
      const startY = e.clientY;
      const basePanX = stateRef.current.panX;
      const basePanY = stateRef.current.panY;
      const rect = wrapperRef.current?.getBoundingClientRect();
      const w = rect?.width ?? 0;
      const h = rect?.height ?? 0;
      const move = (ev: PointerEvent) => {
        const z = stateRef.current.zoom;
        setPanX(clampPan(basePanX + (ev.clientX - startX), z, w));
        setPanY(clampPan(basePanY + (ev.clientY - startY), z, h));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [wrapperRef],
  );

  const transformStyle: CSSProperties = useMemo(
    () => ({
      transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
      transformOrigin: '0 0',
    }),
    [panX, panY, zoom],
  );

  const isZoomed = zoom > min;

  return {
    /** Spread onto the OUTER element for pan. (Wheel is bound natively.) */
    panHandlers: { onPointerDown },
    /** Apply to the INNER coordinate element (the one the drag math measures). */
    transformStyle,
    /** Current zoom factor. */
    zoom,
    /** True when zoomed past fit (show the Reset control). */
    isZoomed,
    /** Reset to fit (zoom 1, pan 0). */
    reset,
    /** Cursor for the pannable background. */
    cursor: isZoomed ? ('grab' as const) : ('default' as const),
  };
}
