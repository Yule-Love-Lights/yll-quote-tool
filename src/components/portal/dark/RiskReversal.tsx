// Portal v2 DARK — Risk Reversal. Five guarantees on dark cards.
// Icon badges are subtly outlined (not filled gold — that's reserved
// for the selection state). Evergreen-tinted backgrounds keep it
// distinct from the "What's Included" band.
//
// WT-56/65/07 — the copy is now Settings-editable + versioned, mirroring
// RiskReversalPermanent (#88 P6b-2): the eyebrow, heading, and bullet TEXT come
// from app_settings (holidayWarranty / eventWarranty / bistroWarranty), while
// the ICONS stay fixed here per service type and pair with the bullets BY INDEX
// (so a reworded bullet keeps its icon, and a blank bullet slot is hidden along
// with its icon). An approved quote freezes the exact text + version it agreed
// to; this component renders whichever copy the caller passes (LIVE settings
// copy for a not-yet-approved portal, the frozen copy on an approved one).

import { Wrench, Lightbulb, Calendar, Home, ShieldCheck, CreditCard } from 'lucide-react';
import type { ServiceType } from '@/lib/serviceType';
import type { ServiceWarranty } from '@/lib/warranty/types';

// Fixed icon slots per vertical, paired with the warranty bullets by index.
// Extra bullets beyond a list fall back to the shield (defensive; the settings
// sanitizer caps bullets at each vertical's slot count).
const HOLIDAY_ICONS: React.ComponentType<{ className?: string }>[] = [
  Wrench,
  Lightbulb,
  Calendar,
  Home,
  ShieldCheck,
];
const EVENT_ICONS: React.ComponentType<{ className?: string }>[] = [
  Wrench,
  Lightbulb,
  Calendar,
  Home,
  ShieldCheck,
];
const BISTRO_ICONS: React.ComponentType<{ className?: string }>[] = [
  ShieldCheck,
  Lightbulb,
  Wrench,
  CreditCard,
];

function iconsFor(serviceType?: ServiceType): React.ComponentType<{ className?: string }>[] {
  if (serviceType === 'event') return EVENT_ICONS;
  if (serviceType === 'permanent_bistro') return BISTRO_ICONS;
  return HOLIDAY_ICONS;
}

export function RiskReversal({
  serviceType,
  warranty,
}: {
  serviceType?: ServiceType;
  warranty: ServiceWarranty;
}) {
  const icons = iconsFor(serviceType);
  // Keep the original slot index (for icon pairing) while dropping blank bullets.
  const bullets = warranty.bullets
    .map((label, idx) => ({ label, idx }))
    .filter((b) => b.label.trim().length > 0);

  return (
    <section
      aria-labelledby="portal-dark-risk-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-10 md:mb-14">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            {warranty.eyebrow}
          </p>
          <h2
            id="portal-dark-risk-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            {warranty.heading}
          </h2>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {bullets.map(({ label, idx }) => {
            const Icon = icons[idx] ?? ShieldCheck;
            return (
              <li
                key={idx}
                className="flex items-start gap-4 p-5 md:p-6 rounded-2xl bg-[#18221C] border border-[#243029] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]"
              >
                <span
                  aria-hidden
                  className="shrink-0 w-10 h-10 rounded-full bg-[#121B16] border border-[#E8B862]/35 flex items-center justify-center"
                >
                  <Icon className="w-5 h-5 text-[#E8B862]" aria-hidden />
                </span>
                <p className="text-[15px] md:text-[16px] text-[#E0D7C1] leading-[1.55]">
                  {label}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
