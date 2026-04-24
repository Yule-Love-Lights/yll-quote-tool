'use client';

// Portal v4 — Section XI: Engagement.
// The final approval CTA — full-width racing green band with a bright red
// "Engage your concierge" button. Reads the live total from selection
// context so the price on this CTA matches the proposal the customer is
// looking at.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';

export type EngagementProps = {
  quoteId: string;
};

export function Engagement({ quoteId }: EngagementProps) {
  const { currentTotal, currentDeposit, activeName } = useSelection();
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  const onEngage = async () => {
    if (submitting || currentTotal <= 0) return;
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 400));
    router.push(`/portal-concierge/${quoteId}/approved`);
  };

  return (
    <section
      aria-labelledby="concierge-engagement-heading"
      className="portal-concierge-band-green portal-concierge-section relative overflow-hidden"
    >
      {/* decorative ornament flourishes, corners */}
      <div className="absolute top-10 left-10 w-12 h-px bg-[var(--yc-brass)] opacity-30" aria-hidden />
      <div className="absolute top-10 right-10 w-12 h-px bg-[var(--yc-brass)] opacity-30" aria-hidden />

      <div className="relative max-w-3xl mx-auto px-6 md:px-10 text-center">
        <p
          className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4"
          style={{ color: 'var(--yc-brass-bright)' }}
        >
          XI
        </p>
        <p
          className="portal-concierge-eyebrow mb-4"
          style={{ color: 'var(--yc-brass-bright)' }}
        >
          Engagement
        </p>
        <h2
          id="concierge-engagement-heading"
          className="font-display text-[40px] md:text-[68px] leading-[1.02] text-[var(--yc-cream-on-green)]"
        >
          Ready to <span className="font-display-italic">begin?</span>
        </h2>
        <p className="mt-5 max-w-xl mx-auto font-display-italic text-[18px] md:text-[22px] text-[var(--yc-brass-bright)] leading-[1.5]">
          A 50% deposit reserves your installation window. Refundable in full until the morning
          of install.
        </p>

        <div className="portal-concierge-ornament mt-10 max-w-sm mx-auto">
          <span
            className="portal-concierge-ornament-mark"
            style={{ color: 'var(--yc-brass-bright)' }}
            aria-hidden
          >
            ✦
          </span>
        </div>
        <style jsx>{`
          section :global(.portal-concierge-ornament)::before,
          section :global(.portal-concierge-ornament)::after {
            background: var(--yc-brass-bright);
            opacity: 0.35;
          }
        `}</style>

        <div className="mt-12 md:mt-14 flex flex-col items-center gap-6">
          <div className="font-display tabular-nums">
            <p className="text-[52px] md:text-[72px] leading-[1] text-[var(--yc-cream-on-green)]">
              {currentTotal > 0 ? formatUsd(currentTotal) : '—'}
            </p>
            <p className="mt-2 text-[14px] md:text-[15px] tracking-[0.22em] uppercase text-[var(--yc-brass-bright)] font-semibold font-sans">
              Deposit today{' '}
              <span className="tabular-nums">
                {currentDeposit > 0 ? formatUsd(currentDeposit) : '—'}
              </span>
            </p>
          </div>

          <button
            type="button"
            onClick={onEngage}
            disabled={submitting || currentTotal <= 0}
            aria-label={`Engage concierge and pay ${formatUsd(currentDeposit)} deposit`}
            className="portal-concierge-btn-primary inline-flex items-center gap-2 px-7 md:px-9 py-4 md:py-5 rounded-sm font-semibold text-[16px] md:text-[18px] tracking-wide cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-brass-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--yc-green)]"
          >
            {submitting ? (
              <>
                <span
                  aria-hidden
                  className="inline-block w-4 h-4 rounded-full border-2 border-[var(--yc-cream)]/30 border-t-[var(--yc-cream)] animate-spin"
                />
                Processing
              </>
            ) : (
              <>
                Engage your concierge
                <ArrowRight className="w-5 h-5" aria-hidden />
              </>
            )}
          </button>

          <p className="text-[13px] md:text-[14px] text-[var(--yc-brass-bright)] max-w-md">
            You will be directed to sign &amp; pay via home.works.
            <span className="block mt-1 text-[var(--yc-cream-on-green)] opacity-70">
              Selected: <span className="font-display-italic">{activeName}</span>
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
