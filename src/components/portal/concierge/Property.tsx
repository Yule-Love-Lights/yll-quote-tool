// Portal v4 — Section II: The Property.
// One full-bleed render of the home, no before/after toggle. Concierge
// treatment: the quote is already vetted, you're looking at the final
// vision. Serif-italic caption sits below like a magazine photo credit.

import Image from 'next/image';

export type PropertyProps = {
  afterUrl: string;
  alt: string;
  address: string;
};

export function Property({ afterUrl, alt, address }: PropertyProps) {
  return (
    <section
      aria-labelledby="concierge-property-heading"
      className="portal-concierge-band portal-concierge-section"
    >
      <div className="max-w-5xl mx-auto px-6 md:px-10">
        <div className="mb-10 md:mb-14 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">II</p>
          <p className="portal-concierge-eyebrow mb-4">The Property</p>
          <h2
            id="concierge-property-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            Your home, <span className="font-display-italic">designed.</span>
          </h2>
        </div>

        <figure>
          <div className="relative w-full aspect-[4/3] md:aspect-[16/10] rounded-sm overflow-hidden bg-[var(--yc-green-deep)] shadow-[var(--yc-shadow-card-hi)]">
            <Image
              src={afterUrl}
              alt={alt}
              fill
              priority
              sizes="(min-width: 1024px) 960px, 100vw"
              className="object-cover"
            />
          </div>
          <figcaption className="mt-5 md:mt-6 text-center">
            <span className="font-display-italic text-[16px] md:text-[18px] text-[var(--yc-ink-soft)]">
              {address}
            </span>
            <span className="block mt-1 text-[12px] text-[var(--yc-ink-muted)] tracking-wide">
              Rendered from a site visit by your concierge.
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
