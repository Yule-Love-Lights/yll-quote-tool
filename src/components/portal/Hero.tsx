'use client';

// Hero — the "magic moment." Personalized headline, full-width render,
// before/after cross-fade toggle. This is where the customer's eye
// lands, so the image must load fast (next/image priority) and the
// CLS budget is zero.

import Image from 'next/image';
import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';

export type HeroProps = {
  firstName: string;
  beforeUrl: string;
  afterUrl: string;
  alt: string;
};

export function Hero({ firstName, beforeUrl, afterUrl, alt }: HeroProps) {
  const [showBefore, setShowBefore] = useState(false);

  return (
    <section
      aria-labelledby="portal-hero-headline"
      className="relative w-full bg-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-10 md:pt-12 md:pb-16">
        {/* Eyebrow */}
        <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3 md:mb-4">
          Your Personalized Design
        </p>

        {/* Headline */}
        <h1
          id="portal-hero-headline"
          className="font-display text-[32px] leading-[1.1] md:text-[52px] md:leading-[1.05] font-semibold text-[#1F1B16] max-w-3xl"
        >
          {firstName}, here&apos;s what your home could look like this holiday season <span aria-hidden>🎄</span>
        </h1>

        {/* Subheadline */}
        <p className="font-display italic text-[18px] md:text-[22px] text-[#3A3229] mt-3 md:mt-4">
          Designed by the President of Holiday Cheer.
        </p>

        {/* Photo container */}
        <div className="mt-6 md:mt-10 relative aspect-[4/3] md:aspect-[16/9] rounded-2xl md:rounded-3xl overflow-hidden shadow-[0_2px_4px_rgba(31,27,22,0.06),0_24px_60px_-16px_rgba(31,27,22,0.18)] ring-1 ring-[#E8DFCC]">
          {/* After (render) — default visible */}
          <Image
            src={afterUrl}
            alt={`${alt} — with Yule Love Lights installed`}
            fill
            priority
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
            className={`object-cover portal-crossfade ${showBefore ? 'opacity-0' : 'opacity-100'}`}
          />
          {/* Before (daytime) */}
          <Image
            src={beforeUrl}
            alt={`${alt} — before installation, daytime reference`}
            fill
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
            className={`object-cover portal-crossfade ${showBefore ? 'opacity-100' : 'opacity-0'}`}
          />

          {/* Warm orange/yellow overlay to simulate dusk glow on the mock render.
           * Remove this block once the real render is wired up. */}
          {!showBefore && (
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none portal-crossfade mix-blend-overlay"
              style={{
                background:
                  'radial-gradient(ellipse at 50% 65%, rgba(255,180,80,0.28), rgba(60,20,10,0.45) 75%)',
              }}
            />
          )}

          {/* Before/after toggle */}
          <button
            type="button"
            onClick={() => setShowBefore((v) => !v)}
            aria-label={showBefore ? 'Show lights-on render' : 'Show daytime photo'}
            aria-pressed={showBefore}
            className="absolute top-3 right-3 md:top-4 md:right-4 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[#FAF6EF]/92 backdrop-blur text-[13px] font-semibold text-[#1F1B16] shadow-[0_2px_8px_rgba(31,27,22,0.15)] cursor-pointer transition-colors duration-200 hover:bg-[#FAF6EF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF]"
          >
            <ArrowLeftRight className="w-4 h-4 text-[#1F3D2B]" aria-hidden />
            {showBefore ? 'See lights on' : 'See before'}
          </button>
        </div>
      </div>
    </section>
  );
}
