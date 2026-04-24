// Portal v2 DARK — What Happens Next. 4-step horizontal timeline on
// desktop with a glowing gold dashed connector. Vertical on mobile.
// Step circles are gold (the brand's warmth) instead of cream/red.

import { CheckCircle2, MessageSquare, Truck, PackageOpen } from 'lucide-react';

type Step = {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  tag?: string;
};

const STEPS: Step[] = [
  {
    icon: CheckCircle2,
    title: 'Approve your quote',
    body: 'Pay a 50% deposit — your slot is locked in.',
    tag: 'Today',
  },
  {
    icon: MessageSquare,
    title: 'Confirm your install date',
    body: 'We text you a 2-hour arrival window the day before.',
  },
  {
    icon: Truck,
    title: 'Our team installs',
    body: '2-4 hours on-site. No mess, no damage, no disruption.',
  },
  {
    icon: PackageOpen,
    title: 'We take everything down',
    body: 'Takedown runs Jan 9 – Feb 3. You don\u2019t lift a finger.',
  },
];

export function WhatHappensNext() {
  return (
    <section
      aria-labelledby="portal-dark-next-heading"
      className="relative w-full bg-[#121B16] border-y border-[#243029]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-12 md:mb-16">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            What Happens Next
          </p>
          <h2
            id="portal-dark-next-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            Four steps from quote to Christmas cheer.
          </h2>
        </div>

        <div className="relative">
          {/* Dashed gold connector — desktop only */}
          <div
            aria-hidden
            className="hidden md:block absolute left-0 right-0 top-[30px] h-px border-t border-dashed border-[#E8B862]/30 mx-[12.5%]"
          />

          <ol className="grid grid-cols-1 md:grid-cols-4 gap-10 md:gap-6 relative">
            {STEPS.map((step, idx) => (
              <li
                key={step.title}
                className="flex md:flex-col items-start md:items-center text-left md:text-center gap-4 md:gap-0"
              >
                <div className="relative shrink-0">
                  <span
                    aria-hidden
                    className="w-[60px] h-[60px] rounded-full bg-[#E8B862] text-[#0B140F] font-display font-bold text-[22px] flex items-center justify-center shadow-[0_0_20px_rgba(232,184,98,0.35),0_4px_12px_rgba(0,0,0,0.5)]"
                  >
                    {idx + 1}
                  </span>
                  <span
                    aria-hidden
                    className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-[#0B140F] border border-[#E8B862]/45 flex items-center justify-center"
                  >
                    <step.icon className="w-4 h-4 text-[#E8B862]" aria-hidden />
                  </span>
                </div>

                <div className="md:mt-5">
                  {step.tag && (
                    <span className="inline-block mb-1.5 px-2.5 py-0.5 rounded-full bg-[#C8313D] text-[#F4ECD8] text-[10px] font-semibold tracking-[0.14em] uppercase shadow-[0_0_14px_rgba(200,49,61,0.4)]">
                      {step.tag}
                    </span>
                  )}
                  <h3 className="font-display text-[19px] md:text-[20px] font-semibold text-[#F4ECD8] leading-[1.25] tracking-[-0.005em]">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-[14px] md:text-[15px] text-[#A89F87] leading-[1.55]">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
