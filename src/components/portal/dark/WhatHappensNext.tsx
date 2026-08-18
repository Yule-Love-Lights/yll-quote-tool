// Portal v2 DARK — What Happens Next. 4-step horizontal timeline on
// desktop with a glowing gold dashed connector. Vertical on mobile.
// Step circles are gold (the brand's warmth) instead of cream/red.

import { CheckCircle2, MessageSquare, Truck, PackageOpen, Lightbulb } from 'lucide-react';
import type { ServiceType } from '@/lib/serviceType';

type Step = {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  tag?: string;
};

// #177: steps are now a FUNCTION of the quote's actual deposit percent
// (default 50) instead of a hardcoded '50%' literal, so a per-quote override
// renders here too.
function steps(depositPercent: number): Step[] {
  return [
    {
      icon: CheckCircle2,
      title: 'Approve your quote',
      body: `We reach out to collect your ${depositPercent}% deposit and lock in your slot.`,
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
      body: 'Takedown runs Jan 9 – Feb 3. You don’t lift a finger.',
    },
  ];
}

function eventSteps(depositPercent: number): Step[] {
  return [
    {
      icon: CheckCircle2,
      title: 'Reserve your date',
      body: `Lock in your design with a ${depositPercent}% deposit.`,
    },
    {
      icon: MessageSquare,
      title: 'Confirm the details',
      body: 'We confirm your install, event, and takedown dates and walk your venue if it helps.',
    },
    {
      icon: Truck,
      title: 'We install',
      body: 'Our team sets everything up before your event and tests every light.',
    },
    {
      icon: PackageOpen,
      title: 'Your event shines',
      body: 'We’re on standby, then take everything down after — clean and complete.',
    },
  ];
}

// PERMANENT BISTRO service line: approve online, then a professional install
// on the poles/supports we set, and the lights stay up year-round (no
// takedown) — mirrors the structure of steps()/eventSteps() above.
function bistroSteps(depositPercent: number): Step[] {
  return [
    {
      icon: CheckCircle2,
      title: 'Approve your quote',
      body: `Approve online, then we collect your ${depositPercent}% deposit and get your install on the schedule.`,
    },
    {
      icon: MessageSquare,
      title: 'We schedule your install',
      body: 'We text you a 2-hour arrival window the day before.',
    },
    {
      icon: Truck,
      title: 'Professional install',
      body: 'Our team sets your poles and supports, then strings your lights. No mess, no disruption.',
    },
    {
      icon: Lightbulb,
      title: 'Your lights stay up year-round',
      body: 'No takedown. Your bistro lights stay strung and ready every night.',
    },
  ];
}

const HOLIDAY_HEADING = 'Four steps from quote to Christmas cheer.';
const EVENT_HEADING = 'From approval to your big night';
const BISTRO_HEADING = 'From approval to lights that stay up for good.';

export function WhatHappensNext({
  serviceType,
  // #177: this quote's actual deposit percent — defaults to 50 (today's
  // behavior) for any caller that hasn't been updated to pass it (e.g. the
  // generic /refer marketing page, which isn't tied to a specific quote).
  depositPercent = 50,
}: {
  serviceType?: ServiceType;
  depositPercent?: number;
}) {
  const isEvent = serviceType === 'event';
  const isPermanentBistro = serviceType === 'permanent_bistro';
  const stepList = isEvent
    ? eventSteps(depositPercent)
    : isPermanentBistro
      ? bistroSteps(depositPercent)
      : steps(depositPercent);
  const heading = isEvent ? EVENT_HEADING : isPermanentBistro ? BISTRO_HEADING : HOLIDAY_HEADING;

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
            {heading}
          </h2>
        </div>

        <div className="relative">
          {/* Dashed gold connector — desktop only */}
          <div
            aria-hidden
            className="hidden md:block absolute left-0 right-0 top-[30px] h-px border-t border-dashed border-[#E8B862]/30 mx-[12.5%]"
          />

          <ol className="grid grid-cols-1 md:grid-cols-4 gap-10 md:gap-6 relative">
            {stepList.map((step, idx) => (
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
