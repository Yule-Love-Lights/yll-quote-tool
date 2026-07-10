'use client';

// Portal v2 DARK — Gallery. Editorial asymmetric grid (desktop) /
// masonry (mobile). Photos look dramatically better against the
// dark surface — the lights pop. Lightbox uses black backdrop with
// gold accent controls.

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';

export type GalleryItem = {
  id: string;
  src: string;
  alt: string;
  neighborhood: string;
};

export type GalleryProps = {
  items: GalleryItem[];
  // Cross-sell strip (#121, S30): the two OTHER service types' completed work,
  // rendered below the main grid. Static images only — not wired into the
  // lightbox.
  crossSell?: Array<{ heading: string; items: GalleryItem[] }>;
};

const DESKTOP_PATTERN = [
  'md:col-span-4 md:row-span-2',
  'md:col-span-4 md:row-span-1',
  'md:col-span-4 md:row-span-1',
  'md:col-span-3 md:row-span-1',
  'md:col-span-5 md:row-span-1',
  'md:col-span-4 md:row-span-1',
];

export function Gallery({ items, crossSell }: GalleryProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  useEffect(() => {
    if (openIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIdx(null);
      if (e.key === 'ArrowLeft')  setOpenIdx((i) => (i === null ? 0 : (i - 1 + items.length) % items.length));
      if (e.key === 'ArrowRight') setOpenIdx((i) => (i === null ? 0 : (i + 1) % items.length));
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openIdx, items.length]);

  return (
    <section
      aria-labelledby="portal-dark-gallery-heading"
      className="relative w-full bg-[#121B16] border-y border-[#243029]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-12 md:mb-14">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Completed Work
          </p>
          <h2
            id="portal-dark-gallery-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            A few of our favorite nights.
          </h2>
        </div>

        <ul className="grid grid-cols-2 md:grid-cols-12 auto-rows-[140px] md:auto-rows-[180px] gap-3 md:gap-4">
          {items.map((it, i) => (
            <li key={it.id} className={`relative ${DESKTOP_PATTERN[i % DESKTOP_PATTERN.length]}`}>
              <button
                type="button"
                onClick={() => setOpenIdx(i)}
                aria-label={`Open ${it.alt}`}
                className="group relative w-full h-full rounded-2xl overflow-hidden cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121B16] border border-[#243029]"
              >
                <Image
                  src={it.src}
                  alt={it.alt}
                  fill
                  loading="lazy"
                  sizes="(max-width: 768px) 50vw, 33vw"
                  className="object-cover transition-transform duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.03]"
                />
                {/* Base darkening — so lights pop */}
                <div
                  aria-hidden
                  className="absolute inset-0 bg-gradient-to-t from-[#0B140F]/70 via-[#0B140F]/15 to-transparent"
                />
                {/* Hover reveal — slight gold wash */}
                <div
                  aria-hidden
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{
                    background: 'radial-gradient(ellipse at 50% 60%, rgba(232,184,98,0.10), transparent 60%)',
                  }}
                />
                <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#0B140F]/70 backdrop-blur-sm border border-[#E8B862]/25 text-[12px] font-semibold text-[#F4ECD8] tracking-[0.02em]">
                  <span
                    aria-hidden
                    className="w-1 h-1 rounded-full bg-[#E8B862] shadow-[0_0_4px_rgba(232,184,98,0.6)]"
                  />
                  {it.neighborhood}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* Cross-sell strip (#121, S30) — the two OTHER service types, so a
            customer on one vertical's portal sees we also do the others.
            Static tiles only, no lightbox wiring. */}
        {crossSell && crossSell.length > 0 && (
          <div className="mt-16 md:mt-20 space-y-10 md:space-y-12">
            {crossSell.map((block) => (
              <div key={block.heading}>
                <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-4">
                  {block.heading}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
                  {block.items.map((it) => (
                    <div
                      key={it.id}
                      className="relative aspect-[4/3] rounded-2xl overflow-hidden border border-[#243029]"
                    >
                      <Image
                        src={it.src}
                        alt={it.alt}
                        fill
                        loading="lazy"
                        sizes="(max-width: 768px) 100vw, 33vw"
                        className="object-cover"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {openIdx !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Gallery viewer"
          className="fixed inset-0 z-50 bg-[#050908]/95 flex items-center justify-center p-4 md:p-8 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setOpenIdx(null); }}
        >
          <button
            type="button"
            onClick={() => setOpenIdx(null)}
            aria-label="Close viewer"
            className="absolute top-4 right-4 w-11 h-11 rounded-full bg-[#18221C] border border-[#E8B862]/30 hover:bg-[#1F2A23] hover:border-[#E8B862]/60 flex items-center justify-center cursor-pointer transition-[background-color,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862]"
          >
            <X className="w-5 h-5 text-[#F4ECD8]" aria-hidden />
          </button>

          <button
            type="button"
            onClick={() => setOpenIdx((i) => (i === null ? 0 : (i - 1 + items.length) % items.length))}
            aria-label="Previous image"
            className="absolute left-3 md:left-6 w-11 h-11 rounded-full bg-[#18221C] border border-[#E8B862]/30 hover:bg-[#1F2A23] hover:border-[#E8B862]/60 flex items-center justify-center cursor-pointer transition-[background-color,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862]"
          >
            <ChevronLeft className="w-5 h-5 text-[#F4ECD8]" aria-hidden />
          </button>

          <div className="relative w-full max-w-5xl aspect-[4/3]">
            <Image
              // Audit fix (#59): pass src directly — the old
              // .replace('w=1000','w=1600') was a no-op for any non-Unsplash
              // URL, blowing up the thumbnail. fill + sizes='100vw' lets
              // next/image pick the right resolution from the full-res source.
              src={items[openIdx].src}
              alt={items[openIdx].alt}
              fill
              sizes="100vw"
              className="object-contain rounded-xl"
            />
            <p className="absolute bottom-[-40px] left-0 right-0 text-center font-display text-[16px] md:text-[18px] text-[#F4ECD8]">
              {items[openIdx].neighborhood}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setOpenIdx((i) => (i === null ? 0 : (i + 1) % items.length))}
            aria-label="Next image"
            className="absolute right-3 md:right-6 w-11 h-11 rounded-full bg-[#18221C] border border-[#E8B862]/30 hover:bg-[#1F2A23] hover:border-[#E8B862]/60 flex items-center justify-center cursor-pointer transition-[background-color,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862]"
          >
            <ChevronRight className="w-5 h-5 text-[#F4ECD8]" aria-hidden />
          </button>
        </div>
      )}
    </section>
  );
}
