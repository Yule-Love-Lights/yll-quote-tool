// Portal v2 DARK — Urgency Banner. Quiet gold-accented strip on
// raised dark surface. No fake countdowns. The pulsing dot is the
// only animated element (and CSS respects reduced-motion).

import { Calendar } from 'lucide-react';

export type UrgencyBannerProps = {
  weeklyBookings: number;
  bookedThroughDate: string;
};

export function UrgencyBanner({ weeklyBookings, bookedThroughDate }: UrgencyBannerProps) {
  return (
    <section
      aria-label="Booking availability"
      className="relative w-full bg-[#121B16] border-y border-[#243029]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 md:py-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-6">
          <div className="flex items-start gap-3">
            <Calendar
              className="w-5 h-5 md:w-6 md:h-6 mt-0.5 text-[#E8B862] shrink-0 drop-shadow-[0_0_8px_rgba(232,184,98,0.4)]"
              aria-hidden
            />
            <p className="text-[15px] md:text-[16px] leading-[1.5] text-[#E0D7C1]">
              Installs book up by{' '}
              <span className="font-semibold text-[#F4ECD8]">{bookedThroughDate}</span>.
              Reserve your spot with a 50% deposit.
            </p>
          </div>

          <div className="flex items-center gap-2.5 md:gap-3 text-[14px] md:text-[15px] md:pl-6 md:border-l md:border-[#243029] text-[#A89F87]">
            <span
              aria-hidden
              className="portal-dark-bulb w-2.5 h-2.5 rounded-full bg-[#E8B862]"
            />
            <p>
              <span className="font-semibold tabular-nums text-[#F4ECD8]">
                {weeklyBookings}
              </span>{' '}
              homes booked this week on Long Island
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
