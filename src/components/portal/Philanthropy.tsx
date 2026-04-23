// Philanthropy — subtle, classy credibility. Full-bleed evergreen
// strip, cream copy. One paragraph, one quiet link.

import { Heart } from 'lucide-react';

const PARTNERS = [
  'Michael Magro Foundation',
  'Beaumont Civic Association',
  'American Cancer Society',
];

export function Philanthropy() {
  return (
    <section
      aria-labelledby="portal-philanthropy-heading"
      className="w-full bg-[#1F3D2B] text-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="flex flex-col md:flex-row md:items-start gap-6 md:gap-12">
          <div className="shrink-0">
            <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-[#C89B3C]/20 flex items-center justify-center">
              <Heart className="w-7 h-7 md:w-8 md:h-8 text-[#D9B15B]" aria-hidden />
            </div>
          </div>

          <div className="flex-1 max-w-3xl">
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#D9B15B] mb-3">
              Every Light Has a Purpose
            </p>
            <h2
              id="portal-philanthropy-heading"
              className="font-display text-[28px] md:text-[38px] leading-[1.15] font-semibold"
            >
              Every season, we light up homes that need it most.
            </h2>
            <p className="mt-5 text-[16px] md:text-[17px] text-[#FAF6EF]/90 leading-[1.65]">
              Each year we donate 8–15 free installs to families and charities including the{' '}
              {PARTNERS.map((p, i) => (
                <span key={p} className="font-semibold text-[#FAF6EF]">
                  {p}{i < PARTNERS.length - 1 ? (i === PARTNERS.length - 2 ? ', and ' : ', ') : ''}
                </span>
              ))}
              . When you choose Yule Love Lights, you&apos;re quietly supporting that mission too.
            </p>
            <a
              href="#"
              className="inline-block mt-6 font-display underline underline-offset-4 text-[#D9B15B] hover:text-[#FAF6EF] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1F3D2B] rounded-sm"
            >
              Learn about our giving →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
