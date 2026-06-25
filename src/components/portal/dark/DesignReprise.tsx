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

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSelection } from '../SelectionContext';
import { LogoWatermark } from '../LogoWatermark';
import type { PortalDesign } from '../types';
import type { BulbColor } from '@/lib/design/sceneTypes';
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
};

export function DesignReprise({
  design,
  palette,
  renderSettings,
  className = 'mt-10 md:mt-12',
}: DesignRepriseProps) {
  // Live selection (#27 D / #10): which drawn items are hidden + the chosen
  // light-color override. Shared with the hero via SelectionContext, so this
  // canvas updates the moment the customer toggles an item or a color above.
  const { hiddenSceneItemIds, colorOverride } = useSelection();

  const wrapRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

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

  // Lock the card to the photo's real aspect so the cover-fit render crops
  // nothing — the whole house shows (matches the #66 hero decision). 8/5
  // fallback for the 640x400 Street View when dimensions are unknown.
  const aspectRatio =
    design.photoW && design.photoH ? `${design.photoW} / ${design.photoH}` : '8 / 5';

  return (
    // Decorative for assistive tech: this is a redundant visual of the hero's
    // design (a canvas with no text content). The hero + the toggleable item
    // list already convey everything, so hide this duplicate region from screen
    // readers rather than announcing an empty canvas + duplicate caption.
    <div className={className} aria-hidden="true">
      <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
        Your home, lit up
      </p>
      <div
        ref={wrapRef}
        className="relative w-full max-h-[70vh] overflow-hidden rounded-2xl border border-[#243029] bg-[#18221C]"
        style={{ aspectRatio }}
      >
        {mounted && (
          <DesignCanvas
            scene={design.scene}
            photoUrl={design.photoUrl}
            photoW={design.photoW}
            photoH={design.photoH}
            hiddenIds={hiddenSceneItemIds}
            colorOverride={colorOverride}
            palette={palette}
            renderSettings={renderSettings}
            className="absolute inset-0"
          />
        )}
        {/* Brand watermark (#45) — corner overlay on the reprise render too. */}
        <LogoWatermark />
      </div>
      <p className="mt-3 text-[13px] text-[#A89F87] leading-[1.6]">
        Updates live as you adjust your selections above.
      </p>
    </div>
  );
}
