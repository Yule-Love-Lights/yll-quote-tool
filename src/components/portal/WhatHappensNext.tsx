// What Happens Next — 4-step visual timeline. Horizontal on desktop
// with a connecting dashed line, vertical on mobile.

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
      aria-labelledby="portal-next-heading"
      className="w-full bg-[#F3EDE1]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-10 md:mb-14">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            What Happens Next
          </p>
          <h2
            id="portal-next-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
          >
            Four steps from quote to Christmas cheer.
          </h2>
        </div>

        {/* Grid with connecting line on desktop */}
        <div className="relative">
          {/* Desktop connector line — behind the circles */}
          <div
            aria-hidden
            className="hidden md:block absolute left-0 right-0 top-[30px] h-px border-t border-dashed border-[#C89B3C]/50 mx-[12.5%]"
          />

          <ol className="grid grid-cols-1 md:grid-cols-4 gap-8 md:gap-6 relative">
            {STEPS.map((step, idx) => (
              <li key={step.title} className="flex md:flex-col items-start md:items-center text-left md:text-center gap-4 md:gap-0">
                <div className="relative shrink-0">
                  <span
                    aria-hidden
                    className="w-[60px] h-[60px] rounded-full bg-[#C89B3C] text-[#1F1B16] font-display font-bold text-[22px] flex items-center justify-center shadow-[0_2px_8px_rgba(200,155,60,0.35)]"
                  >
                    {idx + 1}
                  </span>
                  <span
                    aria-hidden
                    className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-[#FAF6EF] border border-[#E8DFCC] flex items-center justify-center"
                  >
                    <step.icon className="w-4 h-4 text-[#1F3D2B]" aria-hidden />
                  </span>
                </div>

                <div className="md:mt-5">
                  {step.tag && (
                    <span className="inline-block mb-1.5 px-2.5 py-0.5 rounded-full bg-[#B3202D] text-[#FAF6EF] text-[11px] font-semibold tracking-[0.1em] uppercase">
                      {step.tag}
                    </span>
                  )}
                  <h3 className="font-display text-[19px] md:text-[20px] font-semibold text-[#1F1B16] leading-[1.25]">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-[14px] md:text-[15px] text-[#3A3229] leading-[1.5]">
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
