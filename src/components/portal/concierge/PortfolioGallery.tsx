'use client';

// Portal v4 — Section IX: Portfolio.
// Editorial gallery of past work. Portrait-oriented cards arranged in
// an asymmetric grid. Click any image to open a larger view. Neighborhood
// caption in oxblood italic.

import Image from 'next/image';
import { useState, useCallback, useEffect } from 'react';
import { X } from 'lucide-react';

export type PortfolioGalleryProps = {
  items: Array<{ id: string; src: string; neighborhood: string; alt: string }>;
};

export function PortfolioGallery({ items }: PortfolioGalleryProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const open = items.find((i) => i.id === openId);

  // ESC + scroll lock while lightbox open
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [openId, close]);

  return (
    <section
      aria-labelledby="concierge-portfolio-heading"
      className="portal-concierge-band portal-concierge-section"
    >
      <div className="max-w-6xl mx-auto px-6 md:px-10">
        <div className="mb-14 md:mb-16 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">IX</p>
          <p className="portal-concierge-eyebrow mb-4">Portfolio</p>
          <h2
            id="concierge-portfolio-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            Homes <span className="font-display-italic">we&apos;ve lit.</span>
          </h2>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-5">
          {items.map((it, i) => {
            // Alternate tall / standard for editorial feel
            const isTall = i % 5 === 0 || i % 5 === 3;
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => setOpenId(it.id)}
                className={`group relative overflow-hidden rounded-sm border border-[var(--yc-rule-soft)] bg-[var(--yc-green-deep)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-red-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--yc-cream-2)] ${
                  isTall ? 'row-span-2 aspect-[3/4]' : 'aspect-[4/3]'
                }`}
                aria-label={`View ${it.neighborhood}`}
              >
                <Image
                  src={it.src}
                  alt={it.alt}
                  fill
                  sizes="(min-width: 768px) 33vw, 50vw"
                  className="object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                />
                <div
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-[rgba(10,42,20,0.8)] to-transparent"
                />
                <span className="absolute bottom-3 left-4 font-display-italic text-[13px] md:text-[15px] text-[var(--yc-cream-on-green)] drop-shadow">
                  {it.neighborhood}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${open.neighborhood} — photograph`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,42,20,0.88)] backdrop-blur-sm p-4 md:p-10"
          onClick={close}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-[var(--yc-cream)]/90 hover:bg-[var(--yc-cream)] text-[var(--yc-ink)] flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-red-bright)] transition-colors"
          >
            <X className="w-5 h-5" aria-hidden />
          </button>
          <div
            className="relative w-full max-w-5xl aspect-[4/3] rounded-sm overflow-hidden shadow-[0_40px_80px_-20px_rgba(0,0,0,0.7)]"
            onClick={(e) => e.stopPropagation()}
          >
            <Image
              src={open.src.replace('w=1000', 'w=1800')}
              alt={open.alt}
              fill
              sizes="100vw"
              className="object-cover"
              priority
            />
            <span className="absolute bottom-4 left-6 font-display-italic text-[18px] text-[var(--yc-cream-on-green)] drop-shadow">
              {open.neighborhood}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
