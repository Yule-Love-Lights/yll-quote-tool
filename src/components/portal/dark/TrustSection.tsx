// Portal v2 DARK — Trust / social-proof section (#70). Sits at the bottom of the
// customer portal (below the contact card, above the disclaimer). Two rows of
// social proof: real commercial CLIENTS we've decorated for ("Trusted Decorating
// Partner With"), and press "As Seen In" mentions.
//
// Rendered as cream WORDMARKS so they read consistently on the dark theme — the
// same approach the (previously unused) TrustBar took. The press image files in
// public/references are mixed-quality (some are square with NO transparency, so
// they can't be cleanly silhouetted on dark), and the partner brand logos aren't
// in the project yet. To upgrade a row to real logos later: drop transparent,
// light/white PNGs into public/ and swap the wordmark <span> for an <img> — the
// layout (centered, gold-dot dividers, mobile snap-scroll) stays the same.
//
// Brands confirmed by Naldo (S13) as REAL commercial clients — safe to display
// (showing non-clients would be false advertising).

const PARTNERS = ['Marriott', 'Wells Fargo', 'CVS', 'Mattress Firm'];
const PRESS = ['Newsday', 'News 12 Long Island', '1010 WINS', 'iHeart Radio'];

function WordmarkRow({
  label,
  items,
  prominent = false,
}: {
  label: string;
  items: string[];
  prominent?: boolean;
}) {
  return (
    <div>
      <p className="text-center text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-5">
        {label}
      </p>
      <div
        role="list"
        aria-label={label}
        className="portal-dark-snap-x flex items-center justify-start md:justify-center gap-6 md:gap-10 overflow-x-auto md:overflow-visible md:flex-wrap pb-1 md:pb-0 -mx-4 px-4 md:mx-0 md:px-0"
      >
        {items.map((name, i) => (
          <div key={name} role="listitem" className="flex items-center gap-6 md:gap-10 shrink-0">
            <span
              className={`font-display leading-none whitespace-nowrap text-[#E0D7C1]/90 ${
                prominent ? 'text-[20px] sm:text-[24px]' : 'italic text-[17px] sm:text-[19px]'
              }`}
            >
              {name}
            </span>
            {i < items.length - 1 && (
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
        <WordmarkRow label="Trusted Decorating Partner With" items={PARTNERS} prominent />
        <WordmarkRow label="As Seen In" items={PRESS} />
      </div>
    </section>
  );
}
