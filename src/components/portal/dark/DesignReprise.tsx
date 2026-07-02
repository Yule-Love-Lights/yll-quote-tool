'use client';

// #50 — a second, lower-on-page render of the customer's lit design, placed
// between the line-item list and "Optional add-ons" so they can see their
// selections without scrolling back to the hero. Nighttime/lit view ONLY (no
// day/night toggle). It reads the SAME hide + recolor state from the shared
// SelectionContext as the hero, so toggling an item or switching the light
// color updates this render in lockstep — no extra wiring.
//
// Perf: customers are primarily on phones, so the Konva canvas is LAZY-MOUNTED
// — it only renders once the card scrolls near the viewport (Intersection
// Observer), avoiding a second always-on Konva stage on initial page load.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import { useSelection } from '../SelectionContext';
import { LogoWatermark } from '../LogoWatermark';
import type { PortalDesign } from '../types';
import { isItemOnPhoto, type BulbColor } from '@/lib/design/sceneTypes';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';

// Konva is client-only — keep it out of SSR (same pattern the hero uses).
const DesignCanvas = dynamic(() => import('../../design/DesignCanvas'), { ssr: false });

export type DesignRepriseProps = {
  design: PortalDesign;
  // Global app settings (#32) so this render matches the hero's palette +
  // render tunables (e.g. spritzer density).
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
  // Root wrapper classes — defaults to its own top margin, but the caller can
  // override (e.g. to '' when placed inside a grid that owns the spacing, #51).
  className?: string;
  // #51 side-by-side row: at lg+ the image card becomes a fixed height
  // (var(--row-h), set by the parent row) with width derived from the photo's
  // aspect, so it lines up at the same height as the satellite card next to it.
  inRow?: boolean;
};

export function DesignReprise({
  design,
  palette,
  renderSettings,
  className = 'mt-10 md:mt-12',
  inRow = false,
}: DesignRepriseProps) {
  // Live selection (#27 D / #10): which drawn items are hidden + the chosen
  // light-color override. Shared with the hero via SelectionContext, so this
  // canvas updates the moment the customer toggles an item or a color above.
  const { hiddenSceneItemIds, colorOverride } = useSelection();

  const wrapRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  // #13 multi-image: on-image ‹ › arrows step through the photos (no thumbnail
  // strip here — too bulky for this card; Jason's call). Index 0 = base photo.
  const photos = useMemo(
    () => [
      { id: null as string | null, url: design.photoUrl, w: design.photoW, h: design.photoH },
      ...(design.extraPhotos ?? []).filter((p) => p.url).map((p) => ({ id: p.id as string | null, url: p.url, w: p.w as number | null, h: p.h as number | null })),
    ],
    [design],
  );
  const [photoIdx, setPhotoIdx] = useState(0);
  const active = photos[Math.min(photoIdx, photos.length - 1)];
  const activeScene = useMemo(
    () => ({ ...design.scene, items: design.scene.items.filter((i) => isItemOnPhoto(i, active.id)) }),
    [design.scene, active.id],
  );
  const step = (d: 1 | -1) => setPhotoIdx((i) => (i + d + photos.length) % photos.length);

  // Lazy-mount the Konva canvas. IntersectionObserver is the REAL trigger — it
  // fires as the customer scrolls the card toward the viewport, so the second
  // Konva stage stays off the device until they're actually near it (the phone-
  // perf win; a customer who never scrolls down never pays for it). The 15s
  // timer is ONLY a last-resort safety net so the card can't stay blank if IO
  // never fires (broken webview / no IO support) — it's well past the hero-
  // viewing window, so it doesn't reintroduce a second stage during initial
  // browsing. setState is deferred via queueMicrotask (project rule:
  // react-hooks/set-state-in-effect is an error).
  useEffect(() => {
    if (mounted) return;
    const el = wrapRef.current;
    if (!el) return;
    let cancelled = false;
    const reveal = () => {
      if (cancelled) return;
      cancelled = true;
      queueMicrotask(() => setMounted(true));
    };

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) reveal();
        },
        { rootMargin: '200px' },
      );
      io.observe(el);
    }
    const safety = window.setTimeout(reveal, 15000);

    return () => {
      cancelled = true;
      io?.disconnect();
      window.clearTimeout(safety);
    };
  }, [mounted]);

  // "Click here to change colors" — jump the customer up to the LightColorPicker
  // band (#10/#48, id="light-color") and move focus there for keyboard/SR users.
  const goToColors = () => {
    const el = document.getElementById('light-color');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
  };

  // Lock the card to the photo's real aspect so the cover-fit render crops
  // nothing — the whole house shows (matches the #66 hero decision). 8/5
  // fallback for the 640x400 Street View when dimensions are unknown.
  const aspectRatio = active.w && active.h ? `${active.w} / ${active.h}` : '8 / 5';
  // Numeric aspect (w/h) for the #51 row: card width = row-height × this, so the
  // card lands at a definite width at the fixed row height (a block's width:auto
  // ignores aspect-ratio, so we compute it explicitly). Pinned to the BASE photo
  // so the #51 row can't jump widths when the customer steps photos.
  const cardAr = design.photoW && design.photoH ? design.photoW / design.photoH : 8 / 5;

  return (
    // Only the canvas itself is decorative (a redundant visual of the hero's
    // design with no text content), so aria-hidden lives on the image wrapper
    // below — NOT the whole region — because the "Click here to change colors"
    // link is a real control that keyboard/screen-reader users must reach.
    <div
      className={`${className} ${inRow ? 'lg:flex-none lg:[width:calc(var(--row-h)*var(--card-ar))]' : ''}`}
      style={inRow ? ({ ['--card-ar']: cardAr } as CSSProperties) : undefined}
    >
      <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
        Your home, lit up
      </p>
      <div
        ref={wrapRef}
        className={`relative overflow-hidden rounded-2xl border border-[#243029] bg-[#18221C] ${
          inRow
            ? 'w-full max-h-[70vh] lg:w-full lg:max-h-none lg:[height:var(--row-h)]'
            : 'w-full max-h-[70vh]'
        }`}
        style={{ aspectRatio }}
      >
        {/* The canvas itself is decorative — aria-hidden scoped HERE so the #13
            photo arrows below stay reachable for keyboard/SR users. */}
        {mounted && (
          <div aria-hidden="true" className="absolute inset-0">
            <DesignCanvas
              scene={activeScene}
              photoUrl={active.url}
              photoW={active.w}
              photoH={active.h}
              hiddenIds={hiddenSceneItemIds}
              colorOverride={colorOverride}
              palette={palette}
              renderSettings={renderSettings}
              className="absolute inset-0"
            />
          </div>
        )}
        {/* Brand watermark (#45) — corner overlay on the reprise render too. */}
        <LogoWatermark />
        {/* #13 multi-image: on-image arrows + dots (only when extras exist). */}
        {photos.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous photo"
              onClick={() => step(-1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/45 hover:bg-black/65 text-[#F4ECD8] text-lg leading-none flex items-center justify-center"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Next photo"
              onClick={() => step(1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/45 hover:bg-black/65 text-[#F4ECD8] text-lg leading-none flex items-center justify-center"
            >
              ›
            </button>
            <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
              {photos.map((p, i) => (
                <span
                  key={p.id ?? 'base'}
                  className={`w-1.5 h-1.5 rounded-full ${i === photoIdx ? 'bg-[#FFD07A]' : 'bg-white/35'}`}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={goToColors}
        className="mt-3 inline-flex items-center text-[13px] font-semibold text-[#E8B862] hover:text-[#F5CC7A] underline underline-offset-2 leading-[1.6] cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] rounded-sm"
      >
        Click here to change colors
      </button>
    </div>
  );
}
