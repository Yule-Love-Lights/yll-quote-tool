// Portal v2 DARK — Trust Bar. A quiet cream-on-dark strip of press
// wordmarks above the hero. Gold dividers between logos (like tiny
// string-light bulbs). Mobile = horizontal snap-scroll.

const PRESS_MENTIONS = [
  { name: 'Newsday',             featured: 3 },
  { name: '1010 WINS',           featured: 1 },
  { name: 'News 12 Long Island', featured: 1 },
  { name: 'iHeart Radio',        featured: 1 },
];

function PressWordmark({ name, dimmed = false }: { name: string; dimmed?: boolean }) {
  return (
    <span
      className={`font-display italic text-[17px] sm:text-[19px] leading-none whitespace-nowrap ${
        dimmed ? 'text-[#A89F87]' : 'text-[#E0D7C1]/90'
      }`}
    >
      {name}
    </span>
  );
}

export function TrustBar() {
  const logos: Array<{ name: string; dimmed: boolean; key: string }> = [];
  PRESS_MENTIONS.forEach((m) => {
    for (let i = 0; i < m.featured; i++) {
      logos.push({
        name: m.name,
        dimmed: i > 0,
        key: `${m.name}-${i}`,
      });
    }
  });

  return (
    <div className="relative w-full border-b border-[#243029] bg-[#0B140F]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 md:py-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-6">
          {/* Press wordmarks */}
          <div
            role="list"
            aria-label="Press mentions"
            className="portal-dark-snap-x flex items-center gap-5 md:gap-8 overflow-x-auto md:overflow-visible md:flex-wrap pb-1 md:pb-0 -mx-4 px-4 md:mx-0 md:px-0"
          >
            {logos.map((l, i) => (
              <div key={l.key} role="listitem" className="flex items-center gap-5 md:gap-8 shrink-0">
                <PressWordmark name={l.name} dimmed={l.dimmed} />
                {i < logos.length - 1 && (
                  <span
                    aria-hidden
                    className="w-[3px] h-[3px] rounded-full bg-[#E8B862]/70 shadow-[0_0_6px_rgba(232,184,98,0.5)]"
                  />
                )}
              </div>
            ))}
          </div>

          {/* Stats — hidden on mobile */}
          <div className="hidden md:flex items-center gap-4 text-[13px] font-medium text-[#A89F87] whitespace-nowrap shrink-0">
            <span>5 years serving Long Island</span>
            <span
              aria-hidden
              className="w-[3px] h-[3px] rounded-full bg-[#E8B862]/70 shadow-[0_0_6px_rgba(232,184,98,0.5)]"
            />
            <span>200+ homes</span>
          </div>
        </div>
      </div>
    </div>
  );
}
