// Portal v2 DARK — Risk Reversal, PERMANENT variant (#88). Mirrors RiskReversal's
// layout exactly (same dark cards, gold-outlined icon badges) but swaps the
// seasonal-Christmas guarantees for the permanent-lighting value props: a lifetime
// MATERIALS warranty (labor billed separately — Naldo 2026-07-02), year-round app
// color control, an invisible-by-day track, no seasonal takedown, and insurance.

import { Infinity as InfinityIcon, Smartphone, EyeOff, Home, Palette, ShieldCheck } from 'lucide-react';

type Guarantee = { icon: React.ComponentType<{ className?: string }>; label: string };

const GUARANTEES: Guarantee[] = [
  { icon: InfinityIcon, label: 'Lifetime materials warranty — we replace any failed puck, track, or controller free, for as long as you own and live in your home. (Service labor billed separately.)' },
  { icon: Smartphone, label: 'Control it from your phone — millions of colors, scenes, and schedules, year-round, in the app.' },
  { icon: EyeOff, label: 'Invisible by day — a low-profile track color-matched to your trim. You only see it when it’s on.' },
  { icon: Home, label: 'Zero roof damage — mounted in aluminum track under the eave, never nailed through your shingles.' },
  { icon: Palette, label: 'Everyday and every holiday — warm white for nightly curb appeal and security, any color for the seasons.' },
  { icon: ShieldCheck, label: '$2M liability insurance — licensed and bonded, installed by our own crew.' },
];

export function RiskReversalPermanent() {
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
            Built to last a lifetime.
          </h2>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {GUARANTEES.map((g) => (
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
