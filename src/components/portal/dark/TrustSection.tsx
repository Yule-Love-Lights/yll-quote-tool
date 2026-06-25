// Portal v2 DARK — Trust / social-proof section (#70). Sits at the bottom of the
// customer portal (below the contact card, above the disclaimer).
//
// Two rows of social proof on the dark theme:
//  - "Trusted Decorating Partner With": real commercial CLIENTS we've decorated
//    for, shown as their logos (Naldo-supplied, recolored to a uniform brand
//    green, white backgrounds knocked out, in public/partners/).
//  - "As Seen In": press mentions as cream wordmarks (the press image files in
//    public/references are mixed-quality / square-no-transparency, so they don't
//    silhouette cleanly on dark — wordmarks read consistently).
//
// Brands confirmed by Naldo (S13) as REAL clients — safe to display (showing
// non-clients would be false advertising). To add/remove a partner: drop a
// transparent PNG in public/partners/ and edit the PARTNERS list below.

type Partner = { name: string; file: string };

const PARTNERS: Partner[] = [
  { name: 'Marriott', file: 'marriott.png' },
  { name: 'Wells Fargo', file: 'wells-fargo.png' },
  { name: 'CVS', file: 'cvs.png' },
  { name: 'Chick-fil-A', file: 'chick-fil-a.png' },
  { name: 'Mattress Firm', file: 'mattress-firm.png' },
  { name: 'Ferguson', file: 'ferguson.png' },
  { name: 'UBS Arena', file: 'ubs-arena.png' },
  { name: "Leslie's", file: 'leslies.png' },
  { name: 'Orangetheory', file: 'orangetheory.png' },
  { name: 'BottleBuy', file: 'bottlebuy.png' },
];

const PRESS = ['Newsday', 'News 12 Long Island', '1010 WINS', 'iHeart Radio'];

function PartnerLogos() {
  return (
    <div>
      <p className="text-center text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-6">
        Trusted Decorating Partner With
      </p>
      <div
        role="list"
        aria-label="Client partners"
        className="portal-dark-snap-x flex items-center justify-start md:justify-center gap-8 md:gap-x-12 md:gap-y-7 md:flex-wrap overflow-x-auto md:overflow-visible pb-1 md:pb-0 -mx-4 px-4 md:mx-0 md:px-0"
      >
        {PARTNERS.map((p) => (
          <div key={p.file} role="listitem" className="shrink-0">
            {/* Decorative-ish but keep the brand name as alt for a11y. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/partners/${p.file}`}
              alt={p.name}
              loading="lazy"
              className="h-7 md:h-9 w-auto max-w-[150px] object-contain opacity-90"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function PressWordmarks() {
  return (
    <div>
      <p className="text-center text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-5">
        As Seen In
      </p>
      <div
        role="list"
        aria-label="Press mentions"
        className="portal-dark-snap-x flex items-center justify-start md:justify-center gap-6 md:gap-10 overflow-x-auto md:overflow-visible md:flex-wrap pb-1 md:pb-0 -mx-4 px-4 md:mx-0 md:px-0"
      >
        {PRESS.map((name, i) => (
          <div key={name} role="listitem" className="flex items-center gap-6 md:gap-10 shrink-0">
            <span className="font-display italic text-[17px] sm:text-[19px] leading-none whitespace-nowrap text-[#E0D7C1]/90">
              {name}
            </span>
            {i < PRESS.length - 1 && (
              <span
                aria-hidden
                className="w-[3px] h-[3px] rounded-full bg-[#E8B862]/70 shadow-[0_0_6px_rgba(232,184,98,0.5)]"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TrustSection() {
  return (
    <section aria-labelledby="portal-dark-trust-heading" className="relative w-full bg-[#0B140F]">
      <h2 id="portal-dark-trust-heading" className="sr-only">
        Trusted by leading brands and featured in the press
      </h2>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20 flex flex-col gap-12 md:gap-14">
        <PartnerLogos />
        <PressWordmarks />
      </div>
    </section>
  );
}
