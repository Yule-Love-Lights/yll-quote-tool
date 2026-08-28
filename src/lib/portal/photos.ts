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
  if (!design.imageVisibility.street) return [];
  // Crew field photos (the text-ops bot's install capture) are INTERNAL: a
  // ladder, a half-finished install, or a crew member's face must never appear
  // in the homeowner's gallery. This list renders EVERY entry it returns,
  // whether or not a scene item references the photo, so the filter has to live
  // here. One shared read path ⇒ all three portal consumers (InteractiveHero,
  // PhotoGallery, DesignReprise) are covered at once; staff surfaces read
  // design.extraPhotos directly and still see them, which is the point.
  //
  // Dropped BEFORE the labels are computed, unlike the url-less filter below:
  // a crew photo doesn't exist as far as the customer is concerned, so it must
  // not consume a number and leave them looking at "Photo 1, Photo 2, Photo 5".
  const customerExtras = (design.extraPhotos ?? []).filter((p) => p.source !== 'crew');
  const labels = extraPhotoLabels(customerExtras);
  return [
    { id: null, url: design.photoUrl, w: design.photoW, h: design.photoH, title: 'Photo 1' },
    ...customerExtras
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
