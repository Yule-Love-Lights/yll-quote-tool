'use client';

// #154 interim — "How financing works" portal section (Wisetack prequal).
// Informational only: three steps + the same prequal link the sign-modal CTA
// opens. Styled on the RiskReversal ("Your Protection") pattern: evergreen
// band, eyebrow + display headline, dark cards.
//
// Client component because it gates itself on the LIVE selection (useSelection)
// with the SAME pure rules as the sign-modal CTA site: server-threaded prequal
// URL present (flag on + URL configured), service type holiday, permanent, or
// permanent_bistro, job
// total at least the $1,500 YLL floor, balance inside Wisetack's $500–$25,000.
// One portal page serves every vertical, so this gate is what keeps the section
// off event automatically. If the customer's selection dips below the
// floor mid-browse the section disappears — intended and consistent with the
// modal CTA. Renders null (zero DOM) whenever ineligible or the feature is off.

import { useSelection } from '../SelectionContext';
import { financedBalanceUsd, isFinancingEligible } from '@/lib/financing/eligibility';
import type { ServiceType } from '@/lib/serviceType';

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Check your options.',
    body: 'It takes about a minute and checking never affects your credit score.',
  },
  {
    title: 'Pick the plan that fits.',
    body: 'Plans from 3 months and up, including 0% APR options for those who qualify.',
  },
  {
    title: 'Book like normal.',
    body: 'Your deposit holds your install date, and the rest goes on your plan.',
  },
];

export function FinancingSection({
  prequalUrl,
  serviceType,
  viewOnly,
}: {
  /** Server-threaded Wisetack prequal URL (PortalQuote.financing) — undefined = feature off. */
  prequalUrl?: string;
  serviceType?: ServiceType;
  /** #176 — a staff-flagged browse-only quote can never book, so a "Book like
   *  normal" pitch + a live Wisetack link have nothing to lead to. */
  viewOnly?: boolean;
}) {
  const { currentTotal, currentDeposit } = useSelection();
  const eligible =
    !viewOnly &&
    prequalUrl != null &&
    isFinancingEligible({
      enabled: true,
      serviceType,
      totalUsd: currentTotal,
      balanceUsd: financedBalanceUsd(currentTotal, currentDeposit),
    });
  if (!eligible) return null;

  return (
    <section aria-labelledby="portal-dark-financing-heading" className="relative w-full bg-[#0B140F]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-10 md:mb-14">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Flexible Payments
          </p>
          <h2
            id="portal-dark-financing-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            Monthly payments, if you want them.
          </h2>
          <p className="mt-4 text-[15px] md:text-[16px] text-[#E0D7C1] leading-[1.6]">
            We partner with Wisetack so you can split your balance into monthly payments instead
            of paying it all at once.
          </p>
        </div>

        <ol className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-5">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="p-5 md:p-6 rounded-2xl bg-[#18221C] border border-[#243029] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]"
            >
              <span
                aria-hidden
                className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#121B16] border border-[#E8B862]/35 text-[#E8B862] font-display text-[17px] font-semibold"
              >
                {i + 1}
              </span>
              <h3 className="mt-4 font-display text-[18px] md:text-[19px] font-semibold text-[#F4ECD8] leading-[1.3]">
                {step.title}
              </h3>
              <p className="mt-1.5 text-[14px] md:text-[15px] text-[#E0D7C1] leading-[1.55]">
                {step.body}
              </p>
            </li>
          ))}
        </ol>

        {/* Centered solid-amber pill (Naldo 2026-07-18: look like a button,
            centered). Amber, not the Approve red — that pill stays reserved
            for the one money action. */}
        <div className="mt-8 flex justify-center">
          <a
            href={prequalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center min-h-[48px] px-7 py-3 rounded-full bg-[#E8B862] text-[#0B140F] font-semibold text-[15px] cursor-pointer transition-colors duration-200 hover:bg-[#FFD07A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F]"
          >
            See financing options
          </a>
        </div>

        <p className="mt-4 text-[12px] text-[#7B7361] leading-[1.6] max-w-xl mx-auto text-center">
          All financing is subject to credit approval through Wisetack and its lending partners.
          Terms vary.
        </p>
      </div>
    </section>
  );
}
