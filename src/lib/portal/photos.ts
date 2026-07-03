// Portal "before" / "after" photo URLs.
//
// #36 TEARDOWN: these used to be resolved from the Gemini render pipeline
// (`renders` table + private storage bucket — the latest approved/ready AI
// nighttime render per quote). That pipeline is gone. The portal hero is
// the LIVE linked design now (loader.ts attaches it as PortalQuote.design)
// and falls back to the static FALLBACK_HERO image when no design exists.
// The null URLs here are what trigger that fallback chain downstream —
// the adapter still expects the PortalPhotos shape, so the type stays.

import { extraPhotoLabels } from '@/lib/design/photoLabels';
import type { PortalDesign } from '@/components/portal/types';

export type PortalPhotos = {
  beforeUrl: string | null;
  afterUrl: string | null;
  alt: string | null;
};

export function fetchPortalPhotos(customerAddress: string | null): PortalPhotos {
  return {
    beforeUrl: null,
    afterUrl: null,
    alt: customerAddress ? `Photo of ${customerAddress}` : null,
  };
}

// #110 W4-019: the multi-image gallery photo list — [base, ...extraPhotos],
// url-less extras dropped — was hand-built (with drifting shapes/behavior)
// in InteractiveHero, DesignReprise, and PhotoGallery. One pure source now.
//
// W4-022: labels are computed from the extras' CANONICAL (unfiltered) index
// via extraPhotoLabels — the same numbering photoLabels.ts uses for staff —
// BEFORE url-less extras are filtered out, so a broken signed URL on an
// earlier extra can never shift a later photo's displayed number.
export type PortalGalleryPhoto = {
  id: string | null;
  url: string | null;
  w: number | null;
  h: number | null;
  title: string;
};

export function portalPhotos(design: PortalDesign): PortalGalleryPhoto[] {
  const labels = extraPhotoLabels(design.extraPhotos);
  return [
    { id: null, url: design.photoUrl, w: design.photoW, h: design.photoH, title: 'Photo 1' },
    ...(design.extraPhotos ?? [])
      .filter((p) => p.url)
      .map((p) => ({
        id: p.id,
        url: p.url,
        w: p.w as number | null,
        h: p.h as number | null,
        title: labels.get(p.id) ?? 'Photo',
      })),
  ];
}
