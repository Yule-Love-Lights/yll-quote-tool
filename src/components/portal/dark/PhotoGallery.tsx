'use client';

// #13 multi-image — the all-photos gallery (🧪 TRIAL, Jason reviews on device):
// every photo of the house rendered lit AT ONCE, so the customer sees the whole
// display together rather than one angle at a time (the hero strip + reprise
// arrows page through; this lays them side by side). Sits between the totals
// box and "Your Protection". Desktop: 2-across grid; phones: stacked full-width
// (~2 visible per screen — deliberately NOT skipped on mobile; Jason's call).
// Renders nothing for single-photo designs.
//
// Perf: one Konva stage per photo is real weight. The section itself is
// LAZY-MOUNTED via useLazyMountOnVisible so customers who never scroll here
// never pay for it — and once visible, EACH TILE gets its OWN lazy-mount
// (audit W4-024) so N photos don't all spin up their Konva stage in the same
// tick (that spiked main-thread work on a single shared observer firing).
// Each tile reads the SAME SelectionContext hide/recolor state, so toggles
// and color picks update every angle in lockstep.

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useSelection } from '../SelectionContext';
import { useLazyMountOnVisible } from '../useLazyMountOnVisible';
import { LogoWatermark } from '../LogoWatermark';
import type { PortalDesign } from '../types';
import { isItemOnPhoto, type BulbColor, type Scene } from '@/lib/design/sceneTypes';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';
import { portalPhotos, type PortalGalleryPhoto } from '@/lib/portal/photos';

const DesignCanvas = dynamic(() => import('../../design/DesignCanvas'), { ssr: false });

export type PhotoGalleryProps = {
  design: PortalDesign;
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
};

export function PhotoGallery({ design, palette, renderSettings }: PhotoGalleryProps) {
  const { hiddenSceneItemIds, colorOverride } = useSelection();

  const photos = useMemo(() => portalPhotos(design), [design]);

  // Perf fix (audit W4-001): memoize the per-photo scenes on [design.scene,
  // photos] — mirroring DesignReprise's activeScene memo — so a toggle/recolor
  // (which only changes hiddenSceneItemIds/colorOverride, read separately by
  // DesignCanvas) doesn't produce a fresh `scene` object identity every render.
  // DesignCanvas's mount effect keys on `scene` identity (DesignCanvas.tsx), so
  // an unstable scene tore down and remounted every tile's Konva stage on every
  // toggle; a stable identity lets its in-place setHidden/setColorOverride
  // effects handle the update instead.
  const scenesByPhotoId = useMemo(
    () =>
      new Map(
        photos.map((p) => [
          p.id ?? 'base',
          { ...design.scene, items: design.scene.items.filter((i) => isItemOnPhoto(i, p.id)) },
        ]),
      ),
    [design.scene, photos],
  );

  // Section-level lazy-mount (audit W4-023, shared hook): customers who never
  // scroll here never pay for ANY tile's Konva stage.
  const [wrapRef, sectionVisible] = useLazyMountOnVisible<HTMLDivElement>();

  // Single-photo design → no section at all (today's portal).
  if (photos.length <= 1) return null;

  return (
    <section aria-label="Your home from every angle" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 mt-12 md:mt-16">
      <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
        Every angle, lit up
      </p>
      <div ref={wrapRef} className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
        {sectionVisible &&
          photos.map((p) => (
            <GalleryTile
              key={p.id ?? 'base'}
              photo={p}
              scene={scenesByPhotoId.get(p.id ?? 'base')!}
              hiddenSceneItemIds={hiddenSceneItemIds}
              colorOverride={colorOverride}
              palette={palette}
              renderSettings={renderSettings}
            />
          ))}
      </div>
    </section>
  );
}

// One gallery tile — its OWN IntersectionObserver (audit W4-024) so N tiles
// don't all mount their Konva stage in the same tick just because the shared
// section-level observer fired. `sceneItemIds`/`colorOverride` come from the
// parent's single SelectionContext read (no per-tile subscription needed).
function GalleryTile({
  photo,
  scene,
  hiddenSceneItemIds,
  colorOverride,
  palette,
  renderSettings,
}: {
  photo: PortalGalleryPhoto;
  scene: Scene;
  hiddenSceneItemIds: Set<string>;
  colorOverride: string[] | null;
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
}) {
  const [tileRef, mounted] = useLazyMountOnVisible<HTMLDivElement>();
  const aspectRatio = photo.w && photo.h ? `${photo.w} / ${photo.h}` : '8 / 5';
  return (
    <figure className="m-0">
      <div
        ref={tileRef}
        aria-hidden="true"
        className="relative overflow-hidden rounded-2xl border border-[#243029] bg-[#18221C] w-full"
        style={{ aspectRatio }}
      >
        {mounted && (
          <DesignCanvas
            scene={scene}
            photoUrl={photo.url}
            photoW={photo.w}
            photoH={photo.h}
            hiddenIds={hiddenSceneItemIds}
            colorOverride={colorOverride}
            palette={palette}
            renderSettings={renderSettings}
            className="absolute inset-0"
          />
        )}
        <LogoWatermark />
      </div>
      <figcaption className="mt-2 text-[12px] text-[#9fb8a8]">{photo.title}</figcaption>
    </figure>
  );
}
