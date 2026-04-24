// Portal v2 DARK — Philanthropy. Slightly warmer surface (with faint
// red glow in the icon) so the giving section feels emotionally
// distinct from the colder surrounding bands. Still subdued — no
// heart emojis, no cartoon.

import { Heart } from 'lucide-react';

const PARTNERS = [
  'Michael Magro Foundation',
  'Beaumont Civic Association',
  'American Cancer Society',
];

export function Philanthropy() {
  return (
    <section
      aria-labelledby="portal-dark-philanthropy-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="flex flex-col md:flex-row md:items-start gap-6 md:gap-14">
          <div className="shrink-0">
            <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-[#18221C] border border-[#C8313D]/30 flex items-center justify-center shadow-[0_0_22px_rgba(200,49,61,0.18)]">
              <Heart
                className="w-7 h-7 md:w-8 md:h-8 text-[#C8313D] drop-shadow-[0_0_8px_rgba(200,49,61,0.35)]"
                aria-hidden
                strokeWidth={1.75}
              />
            </div>
          </div>

          <div className="flex-1 max-w-3xl">
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
              Every Light Has a Purpose
            </p>
            <h2
              id="portal-dark-philanthropy-heading"
              className="font-display text-[28px] md:text-[40px] leading-[1.15] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
            >
              Every season, we light up homes that need it most.
            </h2>
            <p className="mt-5 text-[16px] md:text-[17px] text-[#E0D7C1]/90 leading-[1.7]">
              Each year we donate 8–15 free installs to families and charities including the{' '}
              {PARTNERS.map((p, i) => (
                <span key={p} className="font-semibold text-[#F4ECD8]">
                  {p}{i < PARTNERS.length - 1 ? (i === PARTNERS.length - 2 ? ', and ' : ', ') : ''}
                </span>
              ))}
              . When you choose Yule Love Lights, you&apos;re quietly supporting that mission too.
            </p>
            <a
              href="#"
              className="inline-block mt-6 font-display underline underline-offset-4 text-[#E8B862] hover:text-[#F5CC7A] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F] rounded-sm"
            >
              Learn about our giving →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
