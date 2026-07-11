// Portal v2 DARK — Risk Reversal. Five guarantees on dark cards.
// Icon badges are subtly outlined (not filled gold — that's reserved
// for the selection state). Evergreen-tinted backgrounds keep it
// distinct from the "What's Included" band.

import { Wrench, Lightbulb, Calendar, Home, ShieldCheck, CreditCard } from 'lucide-react';
import type { ServiceType } from '@/lib/serviceType';

type Guarantee = { icon: React.ComponentType<{ className?: string }>; label: string };

const GUARANTEES: Guarantee[] = [
  { icon: Wrench,        label: 'Free maintenance all season — 48-hour fix guarantee.' },
  { icon: Lightbulb,     label: 'Every bulb guaranteed — we replace burnouts free.' },
  { icon: Calendar,      label: 'Standard takedown included (Jan 9 – Feb 3).' },
  { icon: Home,          label: 'Zero roof damage — clips only, no nails or staples.' },
  { icon: ShieldCheck,   label: '$2M liability insurance — licensed and bonded.' },
];

// EVENT service line: same icons/order/skin, event-voiced copy (no seasonal wording).
const EVENT_GUARANTEES: Guarantee[] = [
  { icon: Wrench,        label: "Something out? We fix it fast. If a bulb or strand goes dark before your event, we're on it — usually the same day." },
  { icon: Lightbulb,     label: 'Every bulb, guaranteed lit. We test the whole display before your event, and again the day of.' },
  { icon: Calendar,      label: 'We handle takedown. Everything comes down on the date we agreed after your event — you never touch a light.' },
  { icon: Home,          label: 'Careful with your space. Professional install with no damage to your home, venue, or landscaping.' },
  { icon: ShieldCheck,   label: 'Fully insured. Licensed and insured, so you and your venue are covered.' },
];

// PERMANENT BISTRO service line: same icons/skin, bistro-voiced copy. A
// year-round product (poles/supports we set, no seasonal wording), so these
// reuse claim TYPES already made for permanent (a workmanship warranty) and
// event (we fix a dark bulb or strand fast) without inventing new promises.
const BISTRO_GUARANTEES: Guarantee[] = [
  { icon: ShieldCheck,   label: 'Every install backed by a workmanship warranty.' },
  { icon: Lightbulb,     label: 'Commercial-grade, weather-rated hardware built to stay outside year-round.' },
  { icon: Wrench,        label: 'Something goes dark? We come fix it. We service everything we hang.' },
  { icon: CreditCard,    label: 'Nothing is charged until you approve your quote.' },
];

export function RiskReversal({ serviceType }: { serviceType?: ServiceType }) {
  const guarantees =
    serviceType === 'event'
      ? EVENT_GUARANTEES
      : serviceType === 'permanent_bistro'
        ? BISTRO_GUARANTEES
        : GUARANTEES;
  return (
    <section
      aria-labelledby="portal-dark-risk-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-10 md:mb-14">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Your Protection
          </p>
          <h2
            id="portal-dark-risk-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            Take the risk out of the decision.
          </h2>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {guarantees.map((g) => (
            <li
              key={g.label}
              className="flex items-start gap-4 p-5 md:p-6 rounded-2xl bg-[#18221C] border border-[#243029] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]"
            >
              <span
                aria-hidden
                className="shrink-0 w-10 h-10 rounded-full bg-[#121B16] border border-[#E8B862]/35 flex items-center justify-center"
              >
                <g.icon className="w-5 h-5 text-[#E8B862]" aria-hidden />
              </span>
              <p className="text-[15px] md:text-[16px] text-[#E0D7C1] leading-[1.55]">
                {g.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
