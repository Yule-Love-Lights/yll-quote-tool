// Portal v2 DARK — Approval confirmation page. Shown after the sticky
// CTA fires on /portal-dark/[quoteId]. Gold-confetti burst, dark cards,
// a referral capture at peak happiness.
//
// This file is a server component (zero JS until confetti + copy-link
// children mount). The confetti + copy-link are the only client
// boundaries.

import Link from 'next/link';
import { Truck, MessageSquare, PackageOpen, Phone, ArrowRight } from 'lucide-react';
import { MOCK_QUOTE, MOCK_TEAM } from '@/components/portal/mockQuote';
import { ApprovalCelebration } from '@/components/portal/dark/ApprovalCelebration';
import { ReferralCard } from '@/components/portal/dark/ReferralCard';

type Params = { quoteId: string };

export default async function PortalDarkApprovedPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { quoteId } = await params;

  // In production this would fetch the quote from the DB by quoteId.
  // For now we use mock data regardless of the param.
  const quote = MOCK_QUOTE;
  const telHref = `tel:${MOCK_TEAM.phone.replace(/[^0-9+]/g, '')}`;

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
      body: '2–4 hours on-site. Clips only — no nails, no staples, no damage.',
    },
    {
      icon: PackageOpen,
      title: 'We take everything down',
      body: 'Takedown runs Jan 9 – Feb 3. Lights, clips, extensions — all gone.',
    },
  ];

  return (
    <main className="relative min-h-screen w-full bg-[#0B140F] overflow-hidden">
      {/* Confetti burst — client boundary, gold-only palette. */}
      <ApprovalCelebration />

      {/* Headline block */}
      <section
        aria-labelledby="approved-dark-headline"
        className="relative w-full"
      >
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 md:pt-28 pb-10 md:pb-14 text-center">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-4">
            Deposit received · Quote {quote.id}
          </p>
          <h1
            id="approved-dark-headline"
            className="font-display text-[40px] leading-[1.05] md:text-[64px] md:leading-[1.02] font-semibold text-[#F4ECD8] tracking-[-0.015em]"
            style={{ textShadow: '0 0 28px rgba(232,184,98,0.18)' }}
          >
            <span aria-hidden>🎄</span> You&apos;re booked!
          </h1>
          <p className="font-display italic text-[20px] md:text-[24px] text-[#E0D7C1] mt-4">
            Here&apos;s what happens next.
          </p>
          <p className="mt-6 text-[16px] md:text-[17px] text-[#A89F87] max-w-xl mx-auto leading-[1.65]">
            Thanks,{' '}
            <span className="font-semibold text-[#E0D7C1]">{quote.customer.firstName}</span>. Your
            spot on our install calendar is officially reserved. We&apos;ll be in touch soon with
            your exact date.
          </p>
        </div>
      </section>

      {/* Booking summary card */}
      <section aria-label="Booking summary" className="w-full">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-10 md:pb-14">
          <div className="rounded-2xl bg-[#18221C] border border-[#243029] p-6 md:p-8 shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#E8B862]">
                  Address
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#F4ECD8] mt-1">
                  {quote.customer.address}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#E8B862]">
                  Install window
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#F4ECD8] mt-1">
                  Mid-November – Early December
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#E8B862]">
                  Takedown
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#F4ECD8] mt-1">
                  Jan 9 – Feb 3
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#E8B862]">
                  Your crew lead
                </dt>
                <dd className="font-display text-[18px] md:text-[20px] font-semibold text-[#F4ECD8] mt-1">
                  {MOCK_TEAM.leaderName}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* Next steps */}
      <section
        aria-labelledby="approved-dark-next-heading"
        className="w-full bg-[#121B16] border-y border-[#243029]"
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20">
          <div className="max-w-xl mb-10 md:mb-12">
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
              What Happens Next
            </p>
            <h2
              id="approved-dark-next-heading"
              className="font-display text-[28px] md:text-[38px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
            >
              You don&apos;t lift a finger from here.
            </h2>
          </div>

          <ol className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
            {nextSteps.map((step, i) => (
              <li
                key={step.title}
                className="relative rounded-2xl bg-[#18221C] border border-[#243029] p-6 md:p-7 shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]"
              >
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-[#18221C] border border-[#E8B862]/45 text-[#E8B862] shadow-[0_0_18px_rgba(232,184,98,0.35)]"
                >
                  <step.icon className="w-5 h-5" aria-hidden />
                </span>
                <p className="mt-4 text-[11px] font-semibold tracking-[0.18em] uppercase text-[#E8B862]">
                  Step {i + 1}
                </p>
                <h3 className="mt-1 font-display text-[19px] md:text-[20px] font-semibold text-[#F4ECD8] leading-[1.25]">
                  {step.title}
                </h3>
                <p className="mt-2 text-[14px] md:text-[15px] text-[#A89F87] leading-[1.6]">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Referral capture — peak happiness moment */}
      <section
        aria-labelledby="approved-dark-referral-heading"
        className="w-full bg-[#0B140F]"
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-8 md:gap-12 items-center">
            <div className="md:col-span-3">
              <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
                Want to help a neighbor?
              </p>
              <h2
                id="approved-dark-referral-heading"
                className="font-display text-[28px] md:text-[40px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
              >
                Refer a neighbor, get{' '}
                <span
                  className="text-[#E8B862]"
                  style={{ textShadow: '0 0 18px rgba(232,184,98,0.35)' }}
                >
                  $100 off
                </span>{' '}
                next year.
              </h2>
              <p className="mt-4 text-[16px] md:text-[17px] text-[#A89F87] leading-[1.65]">
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
        className="w-full bg-[#121B16] border-t border-[#243029]"
      >
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20 text-center">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Questions between now and install day?
          </p>
          <h3 className="font-display text-[26px] md:text-[32px] font-semibold text-[#F4ECD8]">
            Text {MOCK_TEAM.leaderName} directly.
          </h3>
          <a
            href={telHref}
            className="inline-flex items-center gap-2.5 mt-5 px-5 py-3 rounded-xl bg-transparent text-[#E8B862] border border-[#E8B862]/45 font-semibold text-[16px] cursor-pointer transition-[background-color,box-shadow,color] duration-200 hover:bg-[#E8B862]/10 hover:text-[#F5CC7A] shadow-[0_0_16px_rgba(232,184,98,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121B16]"
            style={{ textShadow: '0 0 14px rgba(232,184,98,0.3)' }}
          >
            <Phone className="w-5 h-5" aria-hidden />
            {MOCK_TEAM.phone}
          </a>

          <div className="mt-10">
            <Link
              href={`/portal-dark/${quoteId}`}
              className="inline-flex items-center gap-1.5 font-display underline underline-offset-4 text-[#E8B862] hover:text-[#F5CC7A] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121B16] rounded-sm"
            >
              View your quote
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* Small disclaimer */}
      <footer className="w-full bg-[#0B140F] border-t border-[#243029]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-12 text-center">
          <p className="text-[12px] leading-[1.65] text-[#7B7361] max-w-[65ch] mx-auto">
            A receipt was emailed. Your deposit is fully refundable up until the morning of your install.
          </p>
        </div>
      </footer>
    </main>
  );
}
