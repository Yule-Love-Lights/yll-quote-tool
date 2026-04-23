'use client';

// Gallery — Editorial Grid asymmetric layout on desktop, masonry on
// mobile. Tap to open lightbox with keyboard arrow nav + ESC to close.

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
};

// Asymmetric grid pattern (repeats after 6). Each tile gets a span from
// a fixed pattern so the composition is editorial rather than uniform.
const DESKTOP_PATTERN = [
  'md:col-span-4 md:row-span-2',
  'md:col-span-4 md:row-span-1',
  'md:col-span-4 md:row-span-1',
  'md:col-span-3 md:row-span-1',
  'md:col-span-5 md:row-span-1',
  'md:col-span-4 md:row-span-1',
];

export function Gallery({ items }: GalleryProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  // ESC / arrow key handling when lightbox is open
  useEffect(() => {
    if (openIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIdx(null);
      if (e.key === 'ArrowLeft')  setOpenIdx((i) => (i === null ? 0 : (i - 1 + items.length) % items.length));
      if (e.key === 'ArrowRight') setOpenIdx((i) => (i === null ? 0 : (i + 1) % items.length));
    };
    window.addEventListener('keydown', onKey);
    // Lock scroll while open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openIdx, items.length]);

  return (
    <section
      aria-labelledby="portal-gallery-heading"
      className="w-full bg-[#F3EDE1]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-10 md:mb-12">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            Completed Work
          </p>
          <h2
            id="portal-gallery-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
          >
            A few of our favorite nights.
          </h2>
        </div>

        {/* Grid — mobile: 2-col simple; desktop: editorial asymmetric */}
        <ul className="grid grid-cols-2 md:grid-cols-12 auto-rows-[140px] md:auto-rows-[180px] gap-3 md:gap-4">
          {items.map((it, i) => (
            <li key={it.id} className={`relative ${DESKTOP_PATTERN[i % DESKTOP_PATTERN.length]}`}>
              <button
                type="button"
                onClick={() => setOpenIdx(i)}
                aria-label={`Open ${it.alt}`}
                className="group relative w-full h-full rounded-2xl overflow-hidden cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F3EDE1]"
              >
                <Image
                  src={it.src}
                  alt={it.alt}
                  fill
                  loading="lazy"
                  sizes="(max-width: 768px) 50vw, 33vw"
                  className="object-cover transition-transform duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.03]"
                />
                <div
                  aria-hidden
                  className="absolute inset-0 bg-gradient-to-t from-[#1F1B16]/50 via-transparent to-transparent opacity-80 group-hover:opacity-100 transition-opacity duration-200"
                />
                <span className="absolute bottom-3 left-3 inline-block px-2.5 py-1 rounded-md bg-[#FAF6EF]/85 backdrop-blur text-[12px] font-semibold text-[#1F1B16] tracking-[0.02em]">
                  {it.neighborhood}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Lightbox */}
      {openIdx !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Gallery viewer"
          className="fixed inset-0 z-50 bg-[#1F1B16]/92 flex items-center justify-center p-4 md:p-8"
          onClick={(e) => { if (e.target === e.currentTarget) setOpenIdx(null); }}
        >
          <button
            type="button"
            onClick={() => setOpenIdx(null)}
            aria-label="Close viewer"
            className="absolute top-4 right-4 w-11 h-11 rounded-full bg-[#FAF6EF]/15 hover:bg-[#FAF6EF]/30 flex items-center justify-center cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C]"
          >
            <X className="w-5 h-5 text-[#FAF6EF]" aria-hidden />
          </button>

          <button
            type="button"
            onClick={() => setOpenIdx((i) => (i === null ? 0 : (i - 1 + items.length) % items.length))}
            aria-label="Previous image"
            className="absolute left-3 md:left-6 w-11 h-11 rounded-full bg-[#FAF6EF]/15 hover:bg-[#FAF6EF]/30 flex items-center justify-center cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C]"
          >
            <ChevronLeft className="w-5 h-5 text-[#FAF6EF]" aria-hidden />
          </button>

          <div className="relative w-full max-w-5xl aspect-[4/3]">
            <Image
              src={items[openIdx].src.replace('w=1000', 'w=1600')}
              alt={items[openIdx].alt}
              fill
              sizes="100vw"
              className="object-contain rounded-xl"
            />
            <p className="absolute bottom-[-40px] left-0 right-0 text-center font-display text-[16px] md:text-[18px] text-[#FAF6EF]">
              {items[openIdx].neighborhood}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setOpenIdx((i) => (i === null ? 0 : (i + 1) % items.length))}
            aria-label="Next image"
            className="absolute right-3 md:right-6 w-11 h-11 rounded-full bg-[#FAF6EF]/15 hover:bg-[#FAF6EF]/30 flex items-center justify-center cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C]"
          >
            <ChevronRight className="w-5 h-5 text-[#FAF6EF]" aria-hidden />
          </button>
        </div>
      )}
    </section>
  );
}
