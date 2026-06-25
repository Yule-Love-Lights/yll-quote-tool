// Portal v2 DARK — Personal Contact. Naldo's direct line on a warm
// raised surface with the phone number in glowing gold (not red —
// red is only for the sticky CTA).

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
      aria-labelledby="portal-dark-contact-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-24">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 sm:gap-8 p-6 md:p-8 rounded-2xl bg-[#18221C] border border-[#243029] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]">
          <div className="relative w-[72px] h-[72px] md:w-[88px] md:h-[88px] shrink-0 rounded-full overflow-hidden ring-2 ring-[#E8B862]/45 shadow-[0_0_16px_rgba(232,184,98,0.2)]">
            <Image
              src={photo}
              alt={`${leaderName}'s portrait`}
              fill
              sizes="88px"
              className="object-cover"
            />
          </div>
          <div className="flex-1">
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-1.5">
              Questions? Reach out to the Yule Love Lights Team
            </p>
            <h2 id="portal-dark-contact-heading" className="font-display">
              <a
                href={telHref}
                className="inline-flex items-center gap-2.5 text-[24px] md:text-[28px] font-semibold text-[#E8B862] hover:text-[#F5CC7A] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#18221C] rounded-md tracking-[-0.01em]"
                style={{ textShadow: '0 0 16px rgba(232,184,98,0.35)' }}
              >
                <Phone className="w-5 h-5" aria-hidden />
                {phone}
              </a>
            </h2>
            <p className="mt-1.5 text-[14px] text-[#A89F87]">
              Response within 1 hour during business hours.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
