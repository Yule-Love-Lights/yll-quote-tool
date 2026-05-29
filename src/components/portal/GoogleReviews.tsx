'use client';

// Google Reviews — 5-star rating summary + 2-3 featured quote cards
// in a keyboard-navigable carousel.

import { useState } from 'react';
import { Star, ChevronLeft, ChevronRight } from 'lucide-react';

export type Review = {
  id: string;
  name: string;
  neighborhood: string;
  body: string;
};

export type GoogleReviewsProps = {
  rating: number;      // 0-5
  totalReviews: number;
  reviews: Review[];
  reviewsUrl?: string; // Google Business Profile reviews deep-link
};

function Stars({ count = 5 }: { count?: number }) {
  return (
    <div className="inline-flex items-center gap-1" aria-label={`${count} out of 5 stars`}>
      {Array.from({ length: count }).map((_, i) => (
        <Star key={i} className="w-5 h-5 fill-[#C89B3C] text-[#C89B3C]" aria-hidden />
      ))}
    </div>
  );
}

// Inline minimal Google "G" — avoids pulling a logo library.
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

export function GoogleReviews({ rating, totalReviews, reviews, reviewsUrl }: GoogleReviewsProps) {
  const [idx, setIdx] = useState(0);
  const count = reviews.length;
  const prev = () => setIdx((i) => (i - 1 + count) % count);
  const next = () => setIdx((i) => (i + 1) % count);

  return (
    <section
      aria-labelledby="portal-reviews-heading"
      className="w-full bg-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 md:gap-8 mb-10 md:mb-12">
          <div>
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
              Google Reviews
            </p>
            <h2
              id="portal-reviews-heading"
              className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
            >
              Loved across Long Island.
            </h2>
          </div>

          <div className="flex items-center gap-4">
            <div>
              <p className="font-display text-[40px] md:text-[44px] font-bold text-[#1F1B16] leading-none tabular-nums">
                {rating.toFixed(1)}
              </p>
              <div className="mt-1.5"><Stars count={5} /></div>
            </div>
            <div className="flex flex-col">
              <GoogleG />
              <p className="text-[13px] text-[#6B5F52] mt-1">
                Based on <span className="tabular-nums">{totalReviews}</span> reviews
              </p>
            </div>
          </div>
        </div>

        {/* Review carousel */}
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
            className="rounded-2xl bg-[#F3EDE1] border border-[#E8DFCC] p-6 md:p-10 min-h-[220px] md:min-h-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF]"
          >
            <Stars count={5} />
            <blockquote className="font-display italic text-[20px] md:text-[26px] leading-[1.4] text-[#1F1B16] mt-4">
              &ldquo;{reviews[idx].body}&rdquo;
            </blockquote>
            <figcaption className="mt-5 text-[14px] text-[#6B5F52]">
              — <span className="font-semibold text-[#1F1B16]">{reviews[idx].name}</span>, {reviews[idx].neighborhood}
            </figcaption>
          </div>

          {/* Carousel controls */}
          <div className="flex items-center justify-between mt-5">
            <div className="flex items-center gap-2" role="tablist" aria-label="Select review">
              {reviews.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === idx}
                  aria-label={`Review ${i + 1} of ${count}`}
                  onClick={() => setIdx(i)}
                  className={`w-2.5 h-2.5 rounded-full cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF] ${
                    i === idx ? 'bg-[#B3202D]' : 'bg-[#E8DFCC] hover:bg-[#9E9082]'
                  }`}
                />
              ))}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={prev}
                aria-label="Previous review"
                className="w-11 h-11 rounded-full bg-[#F3EDE1] border border-[#E8DFCC] flex items-center justify-center cursor-pointer transition-colors duration-200 hover:bg-[#E8DFCC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF]"
              >
                <ChevronLeft className="w-5 h-5 text-[#1F1B16]" aria-hidden />
              </button>
              <button
                type="button"
                onClick={next}
                aria-label="Next review"
                className="w-11 h-11 rounded-full bg-[#F3EDE1] border border-[#E8DFCC] flex items-center justify-center cursor-pointer transition-colors duration-200 hover:bg-[#E8DFCC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF]"
              >
                <ChevronRight className="w-5 h-5 text-[#1F1B16]" aria-hidden />
              </button>
            </div>
          </div>

          {reviewsUrl && (
            <a
              href={reviewsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-6 font-display underline underline-offset-4 text-[#1F3D2B] hover:text-[#B8862A] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF] rounded-sm"
            >
              Read all {totalReviews} reviews →
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
