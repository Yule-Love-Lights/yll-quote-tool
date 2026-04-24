'use client';

// Portal v2 DARK — Google Reviews. Gold stars instead of cream.
// Carousel card on raised surface. Keyboard-nav arrows + tab
// indicators.

import { useState } from 'react';
import { Star, ChevronLeft, ChevronRight } from 'lucide-react';

export type Review = {
  id: string;
  name: string;
  neighborhood: string;
  body: string;
};

export type GoogleReviewsProps = {
  rating: number;
  totalReviews: number;
  reviews: Review[];
};

function Stars({ count = 5 }: { count?: number }) {
  return (
    <div className="inline-flex items-center gap-1" aria-label={`${count} out of 5 stars`}>
      {Array.from({ length: count }).map((_, i) => (
        <Star
          key={i}
          className="w-5 h-5 fill-[#E8B862] text-[#E8B862] drop-shadow-[0_0_6px_rgba(232,184,98,0.45)]"
          aria-hidden
        />
      ))}
    </div>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function GoogleReviews({ rating, totalReviews, reviews }: GoogleReviewsProps) {
  const [idx, setIdx] = useState(0);
  const count = reviews.length;
  const prev = () => setIdx((i) => (i - 1 + count) % count);
  const next = () => setIdx((i) => (i + 1) % count);

  return (
    <section
      aria-labelledby="portal-dark-reviews-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-8 md:gap-10 mb-10 md:mb-14">
          <div>
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
              Google Reviews
            </p>
            <h2
              id="portal-dark-reviews-heading"
              className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
            >
              Loved across Long Island.
            </h2>
          </div>

          <div className="flex items-center gap-5">
            <div>
              <p className="font-display text-[40px] md:text-[48px] font-bold text-[#F4ECD8] leading-none tabular-nums tracking-[-0.02em]">
                {rating.toFixed(1)}
              </p>
              <div className="mt-2"><Stars count={5} /></div>
            </div>
            <div className="flex flex-col">
              <GoogleG />
              <p className="text-[13px] text-[#A89F87] mt-1">
                Based on <span className="tabular-nums">{totalReviews}</span> reviews
              </p>
            </div>
          </div>
        </div>

        {/* Review card carousel */}
        <div className="relative">
          <div
            role="region"
            aria-roledescription="carousel"
            aria-label="Featured Google reviews"
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
              if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
            }}
            tabIndex={0}
            className="rounded-2xl bg-[#18221C] border border-[#243029] p-6 md:p-10 min-h-[220px] md:min-h-[220px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]"
          >
            <Stars count={5} />
            <blockquote className="font-display italic text-[20px] md:text-[28px] leading-[1.4] text-[#F4ECD8] mt-5 tracking-[-0.005em]">
              &ldquo;{reviews[idx].body}&rdquo;
            </blockquote>
            <figcaption className="mt-6 text-[14px] text-[#A89F87]">
              — <span className="font-semibold text-[#E0D7C1]">{reviews[idx].name}</span>, {reviews[idx].neighborhood}
            </figcaption>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between mt-6">
            <div className="flex items-center gap-2" role="tablist" aria-label="Select review">
              {reviews.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === idx}
                  aria-label={`Review ${i + 1} of ${count}`}
                  onClick={() => setIdx(i)}
                  className={`w-2.5 h-2.5 rounded-full cursor-pointer transition-[background-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F] ${
                    i === idx
                      ? 'bg-[#E8B862] shadow-[0_0_10px_rgba(232,184,98,0.55)]'
                      : 'bg-[#3C4F43] hover:bg-[#55695D]'
                  }`}
                />
              ))}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={prev}
                aria-label="Previous review"
                className="w-11 h-11 rounded-full bg-[#18221C] border border-[#243029] flex items-center justify-center cursor-pointer transition-[background-color,border-color] duration-200 hover:bg-[#1F2A23] hover:border-[#E8B862]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F]"
              >
                <ChevronLeft className="w-5 h-5 text-[#E0D7C1]" aria-hidden />
              </button>
              <button
                type="button"
                onClick={next}
                aria-label="Next review"
                className="w-11 h-11 rounded-full bg-[#18221C] border border-[#243029] flex items-center justify-center cursor-pointer transition-[background-color,border-color] duration-200 hover:bg-[#1F2A23] hover:border-[#E8B862]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F]"
              >
                <ChevronRight className="w-5 h-5 text-[#E0D7C1]" aria-hidden />
              </button>
            </div>
          </div>

          <a
            href="#"
            className="inline-block mt-6 font-display underline underline-offset-4 text-[#E8B862] hover:text-[#F5CC7A] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F] rounded-sm"
          >
            Read all {totalReviews} reviews →
          </a>
        </div>
      </div>
    </section>
  );
}
