// Per-package preview gallery — Portal v2 DARK theme.
//
// Sister component to /components/portal/PackageVariantGallery.tsx,
// styled for the cinematic dark portal: deep navy background, warm gold
// accents, generous black overlay on each tile so the rendered nighttime
// scene feels like an editorial photo gallery rather than a product grid.
//
// Same data contract as the light version — takes a PortalVariantPhotos
// map. Hides itself entirely when no variants have been rendered yet.

import Image from 'next/image';
import type { PortalVariantPhotos } from '../types';

type Variant = {
  key: keyof PortalVariantPhotos;
  label: string;
  blurb: string;
};

const VARIANTS: Variant[] = [
  { key: 'santas',    label: "Santa's Roofline",   blurb: 'Warm-white C9s along every front gutter.' },
  { key: 'ridge',     label: 'Gingerbread Ridge',  blurb: 'C9s along the roof peak — added on top of Santa’s for a full crown.' },
  { key: 'minis',     label: 'Mini Lights',        blurb: 'Hand-wrapped warm-white minis on bushes, trees, and columns.' },
  { key: 'wreaths',   label: 'Wreaths',            blurb: 'Lit noble pine wreaths on doors, peaks, and porticos.' },
  { key: 'spritzers', label: 'Spritzers',          blurb: 'Metallic starburst stakes lit warm-white in your garden beds.' },
  { key: 'garland',   label: 'Garland',            blurb: 'Lit greenery rope along railings, beams, and door frames.' },
];

export type PackageVariantGalleryProps = {
  variantPhotos: PortalVariantPhotos;
  alt: string;
};

export function PackageVariantGallery({ variantPhotos, alt }: PackageVariantGalleryProps) {
  const available = VARIANTS.filter(v => Boolean(variantPhotos[v.key]));

  if (available.length === 0) return null;

  return (
    <section
      aria-labelledby="portal-dark-variant-gallery-heading"
      className="w-full bg-[#0B0F1A]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-8 md:mb-10">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#D4AF6F] mb-3">
            Built for Your Home
          </p>
          <h2
            id="portal-dark-variant-gallery-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#F5EFE2]"
          >
            Here&rsquo;s what each package looks like at your house.
          </h2>
          <p className="mt-3 text-[16px] md:text-[17px] text-[#B7AC9A] leading-[1.6]">
            We render every product against your daytime photo so you see
            exactly what we&rsquo;ll install — no generic catalog images.
          </p>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
          {available.map(({ key, label, blurb }) => {
            const url = variantPhotos[key]!;
            return (
              <li
                key={key}
                className="flex flex-col bg-[#11172A] rounded-2xl overflow-hidden border border-[#1F2A47] shadow-[0_2px_8px_rgba(0,0,0,0.35),0_24px_48px_-16px_rgba(0,0,0,0.6)]"
              >
                <div className="relative w-full aspect-[4/3] bg-black">
                  <Image
                    src={url}
                    alt={`${label} — ${alt}`}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover"
                  />
                  {/* subtle vignette so the gold label below reads cleanly even when
                      the variant render is bright */}
                  <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />
                </div>
                <div className="p-5">
                  <h3 className="font-display text-[20px] font-semibold text-[#F5EFE2] leading-[1.2]">
                    {label}
                  </h3>
                  <p className="mt-2 text-[14px] text-[#B7AC9A] leading-[1.5]">
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
