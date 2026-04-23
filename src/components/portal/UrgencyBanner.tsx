// Urgency Banner — honest scarcity only. No fake countdowns.
// "12 homes booked this week" is a real DB count in production.

import { Calendar } from 'lucide-react';

export type UrgencyBannerProps = {
  weeklyBookings: number;
  bookedThroughDate: string;
};

export function UrgencyBanner({ weeklyBookings, bookedThroughDate }: UrgencyBannerProps) {
  return (
    <section
      aria-label="Booking availability"
      className="w-full bg-[#1F3D2B] text-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 md:py-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-6">
          <div className="flex items-start gap-3">
            <Calendar className="w-5 h-5 md:w-6 md:h-6 mt-0.5 text-[#D9B15B] shrink-0" aria-hidden />
            <p className="text-[15px] md:text-[16px] leading-[1.5]">
              Installs book up by <span className="font-semibold">{bookedThroughDate}</span>. Reserve your spot with a 50% deposit.
            </p>
          </div>

          <div className="flex items-center gap-2 md:gap-3 text-[14px] md:text-[15px] md:pl-6 md:border-l md:border-[#FAF6EF]/20">
            <span
              aria-hidden
              className="portal-pulse-dot w-2.5 h-2.5 rounded-full bg-[#D9B15B]"
            />
            <p>
              <span className="font-semibold tabular-nums">{weeklyBookings}</span>{' '}
              homes booked this week on Long Island
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
