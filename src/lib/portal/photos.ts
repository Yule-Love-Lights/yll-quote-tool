// Portal "before" / "after" photo URLs.
//
// #36 TEARDOWN: these used to be resolved from the Gemini render pipeline
// (`renders` table + private storage bucket — the latest approved/ready AI
// nighttime render per quote). That pipeline is gone. The portal hero is
// the LIVE linked design now (loader.ts attaches it as PortalQuote.design)
// and falls back to the static FALLBACK_HERO image when no design exists.
// The null URLs here are what trigger that fallback chain downstream —
// the adapter still expects the PortalPhotos shape, so the type stays.

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
