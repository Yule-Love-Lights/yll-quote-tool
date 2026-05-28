// Per-package preview gallery for the customer portal.
//
// Shows one image per package the customer can buy (Santa's Roofline,
// Gingerbread Ridge, Mini Lights, Wreaths, Spritzers, Garland) — each
// rendered against THEIR house, so they can see exactly what each item
// looks like installed. Variants that haven't been generated/approved
// yet are simply omitted; we don't render placeholder cards because an
// empty section is far better than a "coming soon" UX.
//
// This section sits between the Hero (which shows the full package as
// the after-photo) and the PackageCards (where they actually pick a
// bundle). Order: see the house lit up, browse à la carte components,
// THEN choose a bundle.

import Image from 'next/image';
import type { PortalVariantPhotos } from './types';

type Variant = {
  key: keyof PortalVariantPhotos;
  label: string;
  blurb: string;
};

// Mapping copy. Order is the customer-facing display order. The first
// non-empty variant shows in the largest tile; smaller tiles after.
// Stacking semantics for ridge: the rendered image already shows
// gutters + ridge together (see filterVisionForVariant), so the blurb
// reflects "added on top of."
const VARIANTS: Variant[] = [
  { key: 'santas',    label: "Santa's Roofline",   blurb: 'Warm-white C9 bulbs along every front gutter.' },
  { key: 'ridge',     label: 'Gingerbread Ridge',  blurb: 'C9s along the roof peak — added on top of Santa’s for a full crown.' },
  { key: 'minis',     label: 'Mini Lights',        blurb: 'Hand-wrapped warm-white minis on bushes, trees, and columns.' },
  { key: 'wreaths',   label: 'Wreaths',            blurb: 'Lit noble pine wreaths centered on doors, peaks, and porticos.' },
  { key: 'spritzers', label: 'Spritzers',          blurb: 'Metallic starburst stakes lit warm-white in your garden beds.' },
  { key: 'garland',   label: 'Garland',            blurb: 'Lit greenery rope along railings, beams, and door frames.' },
];

export type PackageVariantGalleryProps = {
  variantPhotos: PortalVariantPhotos;
  alt: string;
};

export function PackageVariantGallery({ variantPhotos, alt }: PackageVariantGalleryProps) {
  const available = VARIANTS.filter(v => Boolean(variantPhotos[v.key]));

  // Hide the section entirely when no variants have been rendered yet —
  // an empty section is worse than no section. The Hero still shows the
  // full render so the page isn't naked.
  if (available.length === 0) return null;

  return (
    <section
      aria-labelledby="portal-variant-gallery-heading"
      className="w-full bg-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-8 md:mb-10">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            Built for Your Home
          </p>
          <h2
            id="portal-variant-gallery-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
          >
            Here&rsquo;s what each package looks like at your house.
          </h2>
          <p className="mt-3 text-[16px] md:text-[17px] text-[#3A3229] leading-[1.6]">
            We render every product against your daytime photo so you see
            exactly what we&rsquo;ll install — no generic catalog images.
          </p>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
          {available.map(({ key, label, blurb }) => {
            const url = variantPhotos[key]!;
            return (
              <li key={key} className="flex flex-col bg-white rounded-2xl overflow-hidden border border-[#E8DFCC] shadow-[0_1px_2px_rgba(31,27,22,0.04),0_8px_24px_-8px_rgba(31,27,22,0.08)]">
                <div className="relative w-full aspect-[4/3] bg-[#1F1B16]">
                  <Image
                    src={url}
                    alt={`${label} — ${alt}`}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover"
                  />
                </div>
                <div className="p-5">
                  <h3 className="font-display text-[20px] font-semibold text-[#1F1B16] leading-[1.2]">
                    {label}
                  </h3>
                  <p className="mt-2 text-[14px] text-[#6B5F52] leading-[1.5]">
                    {blurb}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
