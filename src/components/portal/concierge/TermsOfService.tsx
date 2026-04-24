// Portal v4 — Section VI: Terms of service.
// Risk reversal phrased formally, like the terms page of a luxury hotel.
// Three columns, each a promise. No icon blocks, no colored badges —
// serif numerals + red hairlines.

export type TermsOfServiceProps = {
  terms?: Array<{ title: string; body: string }>;
};

const DEFAULT_TERMS: Array<{ title: string; body: string }> = [
  {
    title: 'Deposit, fully refundable.',
    body: 'Your 50% deposit reserves your installation window and may be returned in full up until the morning of your scheduled install — no questions asked.',
  },
  {
    title: 'The Lit-All-Season Guarantee.',
    body: 'A bulb goes out in December, we return within 48 hours and replace it at no cost. This applies to every strand, every night of the season.',
  },
  {
    title: 'Takedown included.',
    body: 'Between January 9 and February 3, our crew returns to remove every strand, clip, timer, and extension — the home returns to exactly how we found it.',
  },
];

export function TermsOfService({ terms = DEFAULT_TERMS }: TermsOfServiceProps) {
  return (
    <section
      aria-labelledby="concierge-terms-heading"
      className="portal-concierge-section"
    >
      <div className="max-w-5xl mx-auto px-6 md:px-10">
        <div className="mb-14 md:mb-16 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">VI</p>
          <p className="portal-concierge-eyebrow mb-4">Terms of service</p>
          <h2
            id="concierge-terms-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            A standard <span className="font-display-italic">held in writing.</span>
          </h2>
        </div>

        <dl className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-14">
          {terms.map((t, i) => (
            <div key={t.title} className="relative">
              <span
                aria-hidden
                className="portal-concierge-numeral text-[20px] md:text-[22px] block mb-3"
              >
                {String.fromCharCode(0x2160 + i)}
                {/* 0x2160 = Ⅰ, 0x2161 = Ⅱ, 0x2162 = Ⅲ — proper Roman numeral Unicode */}
              </span>
              <div
                aria-hidden
                className="h-px bg-[var(--yc-red-deep)] opacity-40 w-12 mb-5"
              />
              <dt className="font-display text-[24px] md:text-[26px] leading-[1.2] text-[var(--yc-ink)] mb-3">
                {t.title}
              </dt>
              <dd className="text-[15px] md:text-[16px] text-[var(--yc-ink-soft)] leading-[1.7]">
                {t.body}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
