// Portal v2 DARK — Trust / social-proof section (#70). Two auto-scrolling
// marquees of social proof, placed between "Your Protection" (RiskReversal) and
// "What Happens Next" on the customer portal:
//  - "Trusted Decorating Partner With": real commercial CLIENTS we've decorated
//    for (logos in public/partners/, uniform brand green, white/box backgrounds
//    knocked out).
//  - "As Seen In": news outlets that featured us (same green treatment).
//
// Brands confirmed by Naldo (S13) as REAL clients/press — safe to display.
//
// Marquee: pure-CSS (see .trust-marquee in portal-dark.css). The row is
// duplicated into two identical groups and the track is translated by one group
// width, so it loops seamlessly with no JS. Pauses on hover; honours
// prefers-reduced-motion (falls back to a manual horizontal scroll). The whole
// marquee is aria-hidden (decorative duplication); an sr-only list carries the
// real brand names for assistive tech.

type Brand = { name: string; file: string };

const PARTNERS: Brand[] = [
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

const PRESS: Brand[] = [
  { name: 'Newsday', file: 'newsday.png' },
  { name: 'News 12 Long Island', file: 'news12.png' },
  { name: '1010 WINS', file: '1010wins.png' },
  { name: 'iHeart Radio', file: 'iheart.png' },
];

function LogoMarquee({ label, items, reps }: { label: string; items: Brand[]; reps: number }) {
  // One marquee "group" repeats the logo set enough times to exceed the viewport
  // width (so there's never a gap); the track holds two identical groups.
  const group: Brand[] = [];
  for (let r = 0; r < reps; r++) group.push(...items);
  return (
    <div>
      <p className="text-center text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-6">
        {label}
      </p>
      <ul className="sr-only">
        {items.map((b) => (
          <li key={b.file}>{b.name}</li>
        ))}
      </ul>
      <div className="trust-marquee" aria-hidden="true">
        <div className="trust-marquee-track">
          {[0, 1].map((g) => (
            <div className="trust-marquee-group" key={g}>
              {group.map((b, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${g}-${i}`}
                  src={`/partners/${b.file}`}
                  alt=""
                  loading="lazy"
                  className="trust-marquee-logo"
                />
              ))}
            </div>
          ))}
        </div>
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
        <LogoMarquee label="Trusted Decorating Partner With" items={PARTNERS} reps={1} />
        <LogoMarquee label="As Seen In" items={PRESS} reps={3} />
      </div>
    </section>
  );
}
