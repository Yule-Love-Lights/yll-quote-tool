// Portal v4 — Section VII: Your concierge.
// A portrait of Naldo on racing green, a signed inscription, and a
// formal sign-off. This is the emotional closer before the approval
// engagement section.

import Image from 'next/image';

export type YourConciergeProps = {
  leaderName: string;
  title: string;
  subtitle: string;
  photo: string;
  body: string;
};

export function YourConcierge({
  leaderName,
  title,
  subtitle,
  photo,
  body,
}: YourConciergeProps) {
  return (
    <section
      aria-labelledby="concierge-person-heading"
      className="portal-concierge-band-green portal-concierge-section"
    >
      <div className="max-w-5xl mx-auto px-6 md:px-10">
        <div className="grid grid-cols-1 md:grid-cols-[1fr,1.4fr] gap-10 md:gap-16 items-center">
          <figure className="relative mx-auto md:mx-0 w-full max-w-sm md:max-w-none">
            <div className="relative aspect-[4/5] rounded-sm overflow-hidden border border-[rgba(244,236,216,0.2)] shadow-[0_2px_8px_rgba(0,0,0,0.35),0_32px_64px_-16px_rgba(0,0,0,0.55)]">
              <Image
                src={photo}
                alt={`${leaderName}, ${title}`}
                fill
                sizes="(min-width: 768px) 380px, 100vw"
                className="object-cover"
              />
            </div>
            <figcaption className="sr-only">
              {leaderName}, {title}
            </figcaption>
          </figure>

          <div>
            <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4 text-[var(--yc-brass-bright)]">
              VII
            </p>
            <p
              className="portal-concierge-eyebrow mb-4"
              style={{ color: 'var(--yc-brass-bright)' }}
            >
              Your concierge
            </p>
            <h2
              id="concierge-person-heading"
              className="font-display text-[40px] md:text-[60px] leading-[1.05] text-[var(--yc-cream-on-green)]"
            >
              {leaderName}.
            </h2>
            <p className="mt-3 font-display-italic text-[18px] md:text-[22px] text-[var(--yc-brass-bright)]">
              {title} · {subtitle}
            </p>

            <div
              aria-hidden
              className="h-px bg-[var(--yc-brass)] opacity-40 w-16 my-8"
            />

            <p className="text-[17px] md:text-[19px] leading-[1.75] text-[var(--yc-cream-on-green)] max-w-xl">
              {body}
            </p>

            <p
              className="mt-10 font-display-italic text-[26px] md:text-[34px] text-[var(--yc-brass-bright)]"
              style={{ transform: 'rotate(-1.5deg)', transformOrigin: 'left' }}
            >
              — {leaderName}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
