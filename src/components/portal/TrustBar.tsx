// Trust Bar — a quiet strip of press logos + stats above the hero.
// Goal: instant credibility BEFORE the customer sees the render.
// Mobile: horizontal snap-scroll (logos can overflow). Desktop: centered.
//
// The four outlets are mixed-format social avatars (two solid-blue squares,
// two transparent wordmarks, iHeart's wordmark is white) — so each sits on
// a uniform white chip with object-contain. That normalizes the clash and
// keeps iHeart's white "iHeart" text from vanishing on the cream band.

import Image from 'next/image';

type PressLogo = {
  name: string;
  src: string;
  // square avatars need a tighter box; wide wordmarks need a wider one
  variant: 'square' | 'wide';
};

const PRESS_LOGOS: PressLogo[] = [
  { name: 'Newsday',             src: '/references/newsday-logo.png', variant: 'square' },
  { name: 'News 12 Long Island', src: '/references/news12-logo.png',  variant: 'wide' },
  { name: '1010 WINS',           src: '/references/1010wins.png',     variant: 'square' },
  { name: 'iHeartRadio',         src: '/references/iheartradio-light.png', variant: 'square' },
];

export function TrustBar() {
  return (
    <div className="w-full bg-[#F3EDE1] border-b border-[#E8DFCC]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 md:py-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-6">
          {/* Eyebrow + logos */}
          <div className="flex items-center gap-4 md:gap-6 min-w-0">
            <span className="hidden sm:inline text-[11px] font-semibold tracking-[0.16em] uppercase text-[#1F3D2B]/70 whitespace-nowrap shrink-0">
              As featured in
            </span>
            <div
              role="list"
              aria-label="Press mentions"
              className="portal-snap-x flex items-center gap-3 md:gap-3.5 overflow-x-auto md:overflow-visible pb-1 md:pb-0 -mx-4 px-4 md:mx-0 md:px-0"
            >
              {PRESS_LOGOS.map((logo) => (
                <div
                  key={logo.name}
                  role="listitem"
                  className={`relative shrink-0 h-9 md:h-10 rounded-md bg-white shadow-[0_1px_3px_rgba(31,27,22,0.1)] ${
                    logo.variant === 'wide' ? 'w-[104px] md:w-[120px]' : 'w-12 md:w-14'
                  }`}
                >
                  <Image
                    src={logo.src}
                    alt={logo.name}
                    fill
                    sizes="120px"
                    className="object-contain p-1.5"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Stats — hidden on mobile to keep strip slim */}
          <div className="hidden md:flex items-center gap-4 text-[13px] font-medium text-[#1F3D2B] whitespace-nowrap shrink-0">
            <span>5 years serving Long Island</span>
            <span aria-hidden className="w-1 h-1 rounded-full bg-[#2D5238]/50" />
            <span>200+ homes</span>
          </div>
        </div>
      </div>
    </div>
  );
}
