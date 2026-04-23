// Personal Contact — Naldo's direct line. `tel:` link so a phone tap
// just dials.

import Image from 'next/image';
import { Phone } from 'lucide-react';

export type PersonalContactProps = {
  leaderName: string;
  photo: string;
  phone: string;
};

export function PersonalContact({ leaderName, photo, phone }: PersonalContactProps) {
  const telHref = `tel:${phone.replace(/[^0-9+]/g, '')}`;
  return (
    <section
      aria-labelledby="portal-contact-heading"
      className="w-full bg-[#F3EDE1]"
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 sm:gap-8 p-6 md:p-8 rounded-2xl bg-[#FAF6EF] border border-[#E8DFCC] shadow-[0_1px_2px_rgba(31,27,22,0.04),0_8px_24px_-8px_rgba(31,27,22,0.08)]">
          <div className="relative w-[72px] h-[72px] md:w-[88px] md:h-[88px] shrink-0 rounded-full overflow-hidden ring-4 ring-[#FBF5E8]">
            <Image
              src={photo}
              alt={`${leaderName}'s portrait`}
              fill
              sizes="88px"
              className="object-cover"
            />
          </div>
          <div className="flex-1">
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-1.5">
              Questions? Text {leaderName} directly
            </p>
            <h2 id="portal-contact-heading" className="font-display">
              <a
                href={telHref}
                className="inline-flex items-center gap-2.5 text-[24px] md:text-[28px] font-semibold text-[#B3202D] hover:text-[#8A1A22] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF] rounded-md"
              >
                <Phone className="w-5 h-5" aria-hidden />
                {phone}
              </a>
            </h2>
            <p className="mt-1 text-[14px] text-[#6B5F52]">
              Response within 1 hour during business hours.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
