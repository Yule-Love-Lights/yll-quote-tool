// Section 16 — Approval confirmation page. Shown after the deposit
// closes on /portal/[quoteId]. Confetti, booking summary, next steps,
// and a peak-happiness referral capture.
//
// This file is deliberately a server component (zero JS until the
// confetti/copy-link child mounts). The confetti + copy-link are
// isolated inside <ApprovalCelebration /> which is the only client
// boundary here — keeps LCP low and the static content pre-rendered.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Truck, MessageSquare, PackageOpen, Phone, ArrowRight } from 'lucide-react';
import { MOCK_QUOTE, MOCK_TEAM } from '@/components/portal/mockQuote';
import { ApprovalCelebration } from '@/components/portal/ApprovalCelebration';
import { ReferralCard } from '@/components/portal/ReferralCard';
import { loadPortalQuote, PortalConfigError } from '@/lib/portal/loader';
import { formatQuoteRef, formatUsd } from '@/components/portal/format';
import type { PortalQuote } from '@/components/portal/types';

type Params = { quoteId: string };

// Same dev-fallback pattern as the main portal page: real DB first, mock
// when Supabase isn't configured. 404 on missing real row. notFound()
// must live OUTSIDE the try/catch — see the main portal page for the
// rationale.
//
// Extra rule for THIS page: even when the row exists, we 404 unless the
// customer has actually approved (quote.approval is populated). Without
// this guard anyone with the URL could preview the celebration page
// before booking, which would be misleading.
async function resolveQuote(quoteId: string): Promise<PortalQuote> {
  let real: PortalQuote | null = null;
  try {
    real = await loadPortalQuote(quoteId);
  } catch (err) {
    if (err instanceof PortalConfigError) return MOCK_QUOTE;
    throw err;
  }
  if (!real) notFound();
  if (!real.approval) notFound();
  return real;
}

export default async function ApprovedPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { quoteId } = await params;
  const quote = await resolveQuote(quoteId);
  const leaderName =
    process.env.NEXT_PUBLIC_PORTAL_LEADER_NAME?.trim() || MOCK_TEAM.leaderName;
  const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || MOCK_TEAM.phone;
  const telHref = `tel:${phone.replace(/[^0-9+]/g, '')}`;

  const nextSteps: Array<{
    icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    title: string;
    body: string;
  }> = [
    {
      icon: MessageSquare,
      title: 'We text you the day before',
      body: 'You get a 2-hour arrival window the night before your install date.',
    },
    {
      icon: Truck,
      title: 'Our team installs',
      body: '2-4 hours on-site. Clips only — no nails, no staples, no damage.',
    },
    {
      icon: PackageOpen,
      title: 'We take everything down',
      body: 'Takedown runs Jan 9 – Feb 3. Lights, clips, extensions — all gone.',
    },
  ];

  return (
    <main className="relative min-h-screen w-full bg-[#FAF6EF] overflow-hidden">
      {/* Confetti + page-level mount animation. Client boundary. */}
      <ApprovalCelebration />

      {/* Headline block */}
      <section
        aria-labelledby="approved-headline"
        className="relative w-full"
      >
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 md:pt-28 pb-10 md:pb-14 text-center">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-4">
            Deposit received · Quote {formatQuoteRef(quote.id)}
          </p>
          <h1
            id="approved-headline"
            className="font-display text-[40px] leading-[1.05] md:text-[64px] md:leading-[1.02] font-semibold text-[#1F1B16]"
          >
            <span aria-hidden>🎄</span> You&apos;re booked!
          </h1>
          <p className="font-display italic text-[20px] md:text-[24px] text-[#3A3229] mt-4">
            Here&apos;s what happens next.
          </p>
          <p className="mt-6 text-[16px] md:text-[17px] text-[#3A3229] max-w-xl mx-auto leading-[1.6]">
            Thanks, <span className="font-semibold">{quote.customer.firstName}</span>. Your spot
            on our install calendar is officially reserved. We&apos;ll be in touch soon with your
            exact date.
          </p>
        </div>
      </section>

      {/* Booking summary card. Top half = what they bought (frozen at
          approval time), bottom half = logistics. Logistics dates are
          intentionally hardcoded for now — the season calendar is a
          global property of the business, not per-quote. */}
      <section aria-label="Booking summary" className="w-full">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-10 md:pb-14">
          <div className="rounded-2xl bg-[#FBF5E8] border border-[#E8DFCC] p-6 md:p-8 shadow-[0_1px_2px_rgba(31,27,22,0.04),0_8px_24px_-8px_rgba(31,27,22,0.08)]">
            {/* Package + price summary — only renders when approval data
                is present (which is enforced by the page-level 404
                already, but cheap belt-and-suspenders). */}
            {quote.approval && (
              <div className="border-b border-[#E8DFCC] pb-5 mb-5 md:pb-6 md:mb-6">
                <p className="text-[11px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B]">
                  Package booked
                </p>
                <p className="font-display text-[22px] md:text-[26px] font-semibold text-[#1F1B16] mt-1">
                  {quote.approval.packageName}
                </p>
                <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
                  <p className="text-[14px] md:text-[15px] text-[#3A3229]">
                    <span className="font-semibold text-[#1F1B16]">{formatUsd(quote.approval.totalUsd)}</span>{' '}
                    season total
                  </p>
                  <p className="text-[14px] md:text-[15px] text-[#3A3229]">
                    <span className="font-semibold text-[#1F3D2B]">{formatUsd(quote.approval.depositUsd)}</span>{' '}
                    deposit paid
                  </p>
                  <p className="text-[14px] md:text-[15px] text-[#3A3229]">
                    Balance{' '}
                    <span className="font-semibold text-[#1F1B16]">
                      {formatUsd(quote.approval.totalUsd - quote.approval.depositUsd)}
                    </span>{' '}
                    on install day
                  </p>
                </div>
              </div>
            )}

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B]">
                  Address
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#1F1B16] mt-1">
                  {quote.customer.address || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B]">
                  Install window
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#1F1B16] mt-1">
                  Mid-November – Early December
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B]">
                  Takedown
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#1F1B16] mt-1">
                  Jan 9 – Feb 3
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B]">
                  Your crew lead
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#1F1B16] mt-1">
                  {leaderName}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* Next steps */}
      <section
        aria-labelledby="approved-next-heading"
        className="w-full bg-[#F3EDE1]"
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20">
          <div className="max-w-xl mb-10 md:mb-12">
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
              What Happens Next
            </p>
            <h2
              id="approved-next-heading"
              className="font-display text-[28px] md:text-[38px] leading-[1.1] font-semibold text-[#1F1B16]"
            >
              You don&apos;t lift a finger from here.
            </h2>
          </div>

          <ol className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
            {nextSteps.map((step, i) => (
              <li
                key={step.title}
                className="relative rounded-2xl bg-[#FAF6EF] border border-[#E8DFCC] p-6 md:p-7 shadow-[0_1px_2px_rgba(31,27,22,0.04),0_8px_24px_-8px_rgba(31,27,22,0.08)]"
              >
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-[#C89B3C] text-[#1F1B16]"
                >
                  <step.icon className="w-5 h-5" aria-hidden />
                </span>
                <p className="mt-4 text-[11px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B]">
                  Step {i + 1}
                </p>
                <h3 className="mt-1 font-display text-[19px] md:text-[20px] font-semibold text-[#1F1B16] leading-[1.25]">
                  {step.title}
                </h3>
                <p className="mt-2 text-[14px] md:text-[15px] text-[#3A3229] leading-[1.55]">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Referral capture — peak happiness moment */}
      <section
        aria-labelledby="approved-referral-heading"
        className="w-full bg-[#1F3D2B] text-[#FAF6EF]"
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-8 md:gap-12 items-center">
            <div className="md:col-span-3">
              <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#D9B15B] mb-3">
                Want to help a neighbor?
              </p>
              <h2
                id="approved-referral-heading"
                className="font-display text-[28px] md:text-[40px] leading-[1.1] font-semibold"
              >
                Refer a neighbor, get <span className="text-[#D9B15B]">$100 off</span> next year.
              </h2>
              <p className="mt-4 text-[16px] md:text-[17px] text-[#FAF6EF]/90 leading-[1.6]">
                Send them your personal link. When they book an install, we&apos;ll credit your
                account automatically — stackable for every friend who joins.
              </p>
            </div>

            <div className="md:col-span-2">
              <ReferralCard quoteId={quoteId} />
            </div>
          </div>
        </div>
      </section>

      {/* Personal contact + return link */}
      <section
        aria-label="Support"
        className="w-full bg-[#FAF6EF]"
      >
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20 text-center">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            Questions between now and install day?
          </p>
          <h3 className="font-display text-[26px] md:text-[32px] font-semibold text-[#1F1B16]">
            Text {leaderName} directly.
          </h3>
          <a
            href={telHref}
            className="inline-flex items-center gap-2.5 mt-5 px-5 py-3 rounded-xl bg-[#B3202D] text-[#FAF6EF] font-semibold text-[16px] cursor-pointer transition-colors duration-200 hover:bg-[#8A1A22] shadow-[0_2px_8px_rgba(179,32,45,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF]"
          >
            <Phone className="w-5 h-5" aria-hidden />
            {phone}
          </a>

          <div className="mt-10">
            <Link
              href={`/portal/${quoteId}`}
              className="inline-flex items-center gap-1.5 font-display underline underline-offset-4 text-[#1F3D2B] hover:text-[#B8862A] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF] rounded-sm"
            >
              View your quote
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* Small disclaimer */}
      <footer className="w-full bg-[#F3EDE1]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-12 text-center">
          <p className="text-[12px] leading-[1.55] text-[#6B5F52] max-w-[65ch] mx-auto">
            A receipt was emailed. Your deposit is fully refundable up until the morning of your install.
          </p>
        </div>
      </footer>
    </main>
  );
}
