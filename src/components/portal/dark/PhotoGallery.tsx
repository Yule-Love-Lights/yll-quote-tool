'use client';

// #13 multi-image — the all-photos gallery (🧪 TRIAL, Jason reviews on device):
// every photo of the house rendered lit AT ONCE, so the customer sees the whole
// display together rather than one angle at a time (the hero strip + reprise
// arrows page through; this lays them side by side). Sits between the totals
// box and "Your Protection". Desktop: 2-across grid; phones: stacked full-width
// (~2 visible per screen — deliberately NOT skipped on mobile; Jason's call).
// Renders nothing for single-photo designs.
//
// Perf: one Konva stage per photo is real weight — the whole section is
// LAZY-MOUNTED via IntersectionObserver (same pattern as DesignReprise), so
// customers who never scroll here never pay for it. Each tile reads the SAME
// SelectionContext hide/recolor state, so toggles and color picks update every
// angle in lockstep.

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSelection } from '../SelectionContext';
import { LogoWatermark } from '../LogoWatermark';
import type { PortalDesign } from '../types';
import { isItemOnPhoto, type BulbColor } from '@/lib/design/sceneTypes';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';

const DesignCanvas = dynamic(() => import('../../design/DesignCanvas'), { ssr: false });

export type PhotoGalleryProps = {
  design: PortalDesign;
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
};

export function PhotoGallery({ design, palette, renderSettings }: PhotoGalleryProps) {
  const { hiddenSceneItemIds, colorOverride } = useSelection();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  const photos = useMemo(
    () => [
      { id: null as string | null, url: design.photoUrl, w: design.photoW, h: design.photoH, title: 'Photo 1' },
      ...(design.extraPhotos ?? [])
        .filter((p) => p.url)
        .map((p, i) => ({ id: p.id as string | null, url: p.url, w: p.w as number | null, h: p.h as number | null, title: p.title || `Photo ${i + 2}` })),
    ],
    [design],
  );

  // Lazy-mount (DesignReprise pattern): IO is the real trigger; the timer is a
  // safety net only. setState deferred (repo rule: set-state-in-effect).
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

  // Single-photo design → no section at all (today's portal).
  if (photos.length <= 1) return null;

  return (
    <section aria-label="Your home from every angle" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 mt-12 md:mt-16">
      <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
        Every angle, lit up
      </p>
      <div ref={wrapRef} className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
        {photos.map((p) => {
          const scene = { ...design.scene, items: design.scene.items.filter((i) => isItemOnPhoto(i, p.id)) };
          const aspectRatio = p.w && p.h ? `${p.w} / ${p.h}` : '8 / 5';
          return (
            <figure key={p.id ?? 'base'} className="m-0">
              <div
                aria-hidden="true"
                className="relative overflow-hidden rounded-2xl border border-[#243029] bg-[#18221C] w-full"
                style={{ aspectRatio }}
              >
                {mounted && (
                  <DesignCanvas
                    scene={scene}
                    photoUrl={p.url}
                    photoW={p.w}
                    photoH={p.h}
                    hiddenIds={hiddenSceneItemIds}
                    colorOverride={colorOverride}
                    palette={palette}
                    renderSettings={renderSettings}
                    className="absolute inset-0"
                  />
                )}
                <LogoWatermark />
              </div>
              <figcaption className="mt-2 text-[12px] text-[#9fb8a8]">{p.title}</figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}
