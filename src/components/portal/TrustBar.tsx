// Trust Bar — a quiet strip of press logos + stats above the hero.
// Goal: instant credibility BEFORE the customer sees the render.
// Mobile: horizontal snap-scroll (logos can overflow). Desktop: centered.

// Lucide has no press-logo set, so we render inline SVG wordmarks. The
// Newsday repetition (3×) is intentional — they've featured YLL three
// separate times and Jason wants that visible.

const PRESS_MENTIONS = [
  { name: 'Newsday',           featured: 3 },
  { name: '1010 WINS',         featured: 1 },
  { name: 'News 12 Long Island', featured: 1 },
  { name: 'iHeart Radio',      featured: 1 },
];

function PressWordmark({ name, dimmed = false }: { name: string; dimmed?: boolean }) {
  return (
    <span
      className={`font-display italic text-[17px] sm:text-[19px] leading-none whitespace-nowrap ${
        dimmed ? 'text-[#2D5238]/55' : 'text-[#2D5238]/80'
      }`}
    >
      {name}
    </span>
  );
}

export function TrustBar() {
  // Expand Newsday 3× with subtle dimming so it reads as "featured 3x"
  // rather than literal triplicate.
  const logos: Array<{ name: string; dimmed: boolean; key: string }> = [];
  PRESS_MENTIONS.forEach((m) => {
    for (let i = 0; i < m.featured; i++) {
      logos.push({
        name: m.name,
        dimmed: i > 0, // first full-strength, repeats slightly dimmer
        key: `${m.name}-${i}`,
      });
    }
  });

  return (
    <div className="w-full bg-[#F3EDE1] border-b border-[#E8DFCC]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 md:py-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-6">
          {/* Press logos */}
          <div
            role="list"
            aria-label="Press mentions"
            className="portal-snap-x flex items-center gap-5 md:gap-8 overflow-x-auto md:overflow-visible md:flex-wrap pb-1 md:pb-0 -mx-4 px-4 md:mx-0 md:px-0"
          >
            {logos.map((l, i) => (
              <div key={l.key} role="listitem" className="flex items-center gap-5 md:gap-8 shrink-0">
                <PressWordmark name={l.name} dimmed={l.dimmed} />
                {i < logos.length - 1 && (
                  <span aria-hidden className="w-1 h-1 rounded-full bg-[#2D5238]/30" />
                )}
              </div>
            ))}
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
