// Portal v4 — Section VIII: In recent service.
// Testimonials rendered as pull-quotes, NOT a carousel. Each gets a
// full paragraph of editorial space with a large opening quote mark
// in oxblood.

export type RecentServiceProps = {
  reviews: Array<{
    id: string;
    name: string;
    neighborhood: string;
    body: string;
  }>;
};

export function RecentService({ reviews }: RecentServiceProps) {
  const three = reviews.slice(0, 3);

  return (
    <section
      aria-labelledby="concierge-recent-heading"
      className="portal-concierge-section"
    >
      <div className="max-w-4xl mx-auto px-6 md:px-10">
        <div className="mb-14 md:mb-16 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">VIII</p>
          <p className="portal-concierge-eyebrow mb-4">In recent service</p>
          <h2
            id="concierge-recent-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            From the homes <span className="font-display-italic">we serve.</span>
          </h2>
        </div>

        <div className="space-y-16 md:space-y-24">
          {three.map((r, idx) => (
            <figure key={r.id} className="relative">
              <span
                aria-hidden
                className="absolute -left-2 md:-left-6 -top-8 md:-top-12 font-display text-[110px] md:text-[160px] leading-[0.8] text-[var(--yc-red-deep)] opacity-25 select-none"
              >
                &ldquo;
              </span>

              <blockquote className="relative font-display-italic text-[22px] md:text-[30px] leading-[1.45] text-[var(--yc-ink)] max-w-3xl">
                {r.body}
              </blockquote>

              <figcaption className="mt-6 md:mt-8 flex items-center gap-4">
                <span
                  aria-hidden
                  className="h-px bg-[var(--yc-red-deep)] opacity-50 w-10 flex-shrink-0"
                />
                <span className="text-[14px] md:text-[15px] text-[var(--yc-ink-soft)]">
                  <span className="font-semibold text-[var(--yc-ink)]">{r.name}</span>
                  <span className="text-[var(--yc-ink-muted)]"> · {r.neighborhood}</span>
                </span>
              </figcaption>

              {idx < three.length - 1 && (
                <div
                  aria-hidden
                  className="portal-concierge-ornament mt-16 md:mt-20 max-w-xs mx-auto"
                >
                  <span className="portal-concierge-ornament-mark">✦</span>
                </div>
              )}
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
