'use client';

// Portal v2 DARK — Hero. Full-bleed dusk photo with a warm golden
// bloom overlay (mix-blend-mode: screen) so the bulbs feel like they
// ARE emitting light rather than painted on. Headline floats over
// the photo instead of sitting above it — more cinematic, less
// landing-page-y.

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
      aria-labelledby="portal-dark-hero-headline"
      className="relative w-full overflow-hidden"
    >
      {/* Full-bleed photo stack */}
      <div className="relative w-full h-[78vh] min-h-[560px] md:min-h-[680px] max-h-[900px]">
        {/* After (render) — default visible */}
        <Image
          src={afterUrl}
          alt={`${alt} — with Yule Love Lights installed`}
          fill
          priority
          sizes="100vw"
          className={`object-cover portal-dark-crossfade ${showBefore ? 'opacity-0' : 'opacity-100'}`}
        />
        {/* Before (daytime) */}
        <Image
          src={beforeUrl}
          alt={`${alt} — before installation, daytime reference`}
          fill
          sizes="100vw"
          className={`object-cover portal-dark-crossfade ${showBefore ? 'opacity-100' : 'opacity-0'}`}
        />

        {/* Warm golden bloom — only over the "after" state */}
        {!showBefore && (
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none portal-dark-hero-bloom portal-dark-crossfade"
          />
        )}

        {/* Bottom vignette so text is always legible */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none bg-gradient-to-t from-[#0B140F]/95 via-[#0B140F]/55 to-transparent"
        />
        {/* Top subtle vignette */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-40 pointer-events-none bg-gradient-to-b from-[#0B140F]/70 to-transparent"
        />

        {/* Before/after toggle — minimal gold pill top-right */}
        <button
          type="button"
          onClick={() => setShowBefore((v) => !v)}
          aria-label={showBefore ? 'Show lights-on render' : 'Show daytime photo'}
          aria-pressed={showBefore}
          className="absolute top-4 right-4 md:top-6 md:right-6 inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-[#0B140F]/70 backdrop-blur-md border border-[#E8B862]/40 text-[13px] font-semibold text-[#F4ECD8] cursor-pointer transition-[background-color,border-color,box-shadow] duration-200 hover:bg-[#0B140F]/90 hover:border-[#E8B862]/70 hover:shadow-[0_0_16px_rgba(232,184,98,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F]"
        >
          <ArrowLeftRight className="w-4 h-4 text-[#E8B862]" aria-hidden />
          {showBefore ? 'See lights on' : 'See before'}
        </button>

        {/* Headline — absolutely positioned so it floats over the photo */}
        <div className="absolute inset-x-0 bottom-0 z-10">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-10 md:pb-16">
            {/* Eyebrow with bulb dot */}
            <div className="flex items-center gap-2.5 mb-4 md:mb-5">
              <span
                aria-hidden
                className="portal-dark-bulb w-2 h-2 rounded-full bg-[#E8B862]"
              />
              <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862]">
                Your Personalized Design
              </p>
            </div>

            <h1
              id="portal-dark-hero-headline"
              className="font-display text-[34px] leading-[1.08] md:text-[64px] md:leading-[1.02] font-semibold text-[#F4ECD8] max-w-3xl tracking-[-0.01em]"
              style={{ textShadow: '0 2px 24px rgba(0,0,0,0.5)' }}
            >
              {firstName}, here&apos;s what your home looks like lit up.
            </h1>

            <p className="font-display italic text-[18px] md:text-[24px] text-[#E0D7C1]/90 mt-4 md:mt-5 max-w-2xl">
              Designed by the President of Holiday Cheer.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
