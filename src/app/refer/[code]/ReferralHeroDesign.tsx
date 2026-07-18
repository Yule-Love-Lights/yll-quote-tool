'use client';

// Referral landing page bug batch 2026-07-17 (ledger #41) — fix 1: the hero
// used to show the referrer's RAW base house photo (no lights); the lights
// only exist as scene data the design editor draws OVER the photo. This
// mounts the SAME live lit-design render the portal uses (DesignCanvas),
// read-only: no toggles, no SelectionContext (this page has none) — hiddenIds
// and colorOverride are always empty/null, mirroring how DesignReprise's
// portal-hero pattern passes them.
//
// Mounted immediately (the hero is above the fold) — unlike DesignReprise's
// lazy IntersectionObserver mount further down the portal page.
//
// Falls back to the referrer's completed-work gallery photo (the same
// fallback the pre-fix hero always showed) if the Konva render itself fails
// at runtime — reuses ReferralHeroImage for that fallback render so the two
// failure paths (no design at all vs. a design whose render broke) look
// identical to the visitor.

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { isItemOnPhoto, type Scene, type BulbColor } from '@/lib/design/sceneTypes';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';
import { ReferralHeroImage } from './ReferralHeroImage';

// Konva is client-only — keep it out of SSR (same pattern as DesignReprise /
// InteractiveHero).
const DesignCanvas = dynamic(() => import('@/components/design/DesignCanvas'), { ssr: false });

export function ReferralHeroDesign({
  scene,
  photoUrl,
  photoW,
  photoH,
  palette,
  renderSettings,
  alt,
  fallbackSrc,
}: {
  scene: Scene;
  photoUrl: string;
  photoW: number | null;
  photoH: number | null;
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
  alt: string;
  fallbackSrc: string;
}) {
  const [renderFailed, setRenderFailed] = useState(false);

  if (renderFailed) {
    return <ReferralHeroImage src={fallbackSrc} alt={alt} />;
  }

  // Base-photo-only items — #13 multi-image items drawn on OTHER photos never
  // apply to this single-photo hero (same photoId filter InteractiveHero /
  // DesignReprise apply for their own base-photo view; the base photo's id is
  // always null, see src/lib/portal/photos.ts).
  const baseScene: Scene = { ...scene, items: scene.items.filter((i) => isItemOnPhoto(i, null)) };

  return (
    <div role="img" aria-label={alt} className="absolute inset-0 w-full h-full">
      <DesignCanvas
        scene={baseScene}
        photoUrl={photoUrl}
        photoW={photoW}
        photoH={photoH}
        hiddenIds={undefined}
        colorOverride={null}
        palette={palette}
        renderSettings={renderSettings}
        onRenderError={() => setRenderFailed(true)}
        className="absolute inset-0"
      />
    </div>
  );
}
