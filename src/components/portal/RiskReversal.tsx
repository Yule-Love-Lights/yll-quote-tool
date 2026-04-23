// Risk Reversal — six guarantees that remove objections. This section
// is static (no client JS). 2x3 on desktop, stacks on mobile.

import { CheckCircle2, Wrench, Lightbulb, Calendar, Home, ShieldCheck } from 'lucide-react';

type Guarantee = { icon: React.ComponentType<{ className?: string }>; label: string };

const GUARANTEES: Guarantee[] = [
  { icon: CheckCircle2,  label: 'Full refund anytime before install day.' },
  { icon: Wrench,        label: 'Free maintenance all season — 48-hour fix guarantee.' },
  { icon: Lightbulb,     label: 'Every bulb guaranteed — we replace burnouts free.' },
  { icon: Calendar,      label: 'Standard takedown included (Jan 9 – Feb 3).' },
  { icon: Home,          label: 'Zero roof damage — clips only, no nails or staples.' },
  { icon: ShieldCheck,   label: '$2M liability insurance — licensed and bonded.' },
];

export function RiskReversal() {
  return (
    <section
      aria-labelledby="portal-risk-heading"
      className="w-full bg-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-8 md:mb-12">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            Your Protection
          </p>
          <h2
            id="portal-risk-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
          >
            Take the risk out of the decision.
          </h2>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {GUARANTEES.map((g) => (
            <li
              key={g.label}
              className="flex items-start gap-4 p-5 md:p-6 rounded-2xl bg-[#F3EDE1] border border-[#E8DFCC]"
            >
              <span
                aria-hidden
                className="shrink-0 w-10 h-10 rounded-full bg-[#EDF2EC] flex items-center justify-center"
              >
                <g.icon className="w-5 h-5 text-[#1F3D2B]" aria-hidden />
              </span>
              <p className="text-[15px] md:text-[16px] text-[#1F1B16] leading-[1.5]">
                {g.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
