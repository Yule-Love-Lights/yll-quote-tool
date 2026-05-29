// Portal v2/v6 DARK — About Yule Love Lights. Company story, credential
// chips, and the team photo, dark-themed. Replaces the old single-person
// "Led by Naldo" bio to match v1: lead with the company, not the individual.

import Image from 'next/image';
import { ShieldCheck } from 'lucide-react';

export type MeetYourTeamProps = {
  photo: string;
  paragraphs: string[];
  badges?: string[];
};

export function MeetYourTeam({ photo, paragraphs, badges = [] }: MeetYourTeamProps) {
  return (
    <section
      aria-labelledby="portal-dark-team-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 items-start">
          {/* Team photo */}
          <div className="md:col-span-5">
            <div className="relative w-full aspect-[3/2] rounded-2xl overflow-hidden ring-1 ring-[#E8B862]/40 shadow-[0_0_32px_rgba(232,184,98,0.18),0_12px_40px_rgba(0,0,0,0.6)]">
              <Image
                src={photo}
                alt="The Yule Love Lights crew in front of the company trailer"
                fill
                sizes="(max-width: 768px) 100vw, 460px"
                className="object-cover"
              />
            </div>
          </div>

          {/* Company story */}
          <div className="md:col-span-7">
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
              About Yule Love Lights
            </p>
            <h2
              id="portal-dark-team-heading"
              className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
            >
              Long Island&apos;s family-owned lighting company.
            </h2>

            {badges.length > 0 && (
              <ul className="mt-5 flex flex-wrap gap-2" aria-label="Credentials">
                {badges.map((b) => (
                  <li
                    key={b}
                    className="text-[12px] font-semibold text-[#E8B862] bg-[#E8B862]/10 border border-[#E8B862]/30 rounded-full px-3 py-1"
                  >
                    {b}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6 space-y-4 text-[15px] md:text-[16px] text-[#C9C0AA] leading-[1.7] max-w-[65ch]">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>

            <div className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#E8B862]/10 border border-[#E8B862]/30 px-4 py-2.5">
              <ShieldCheck className="w-4 h-4 text-[#E8B862] shrink-0" aria-hidden />
              <span className="text-[14px] font-semibold text-[#F4ECD8]">
                Backed by our Grinch-Proof Guarantee
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
