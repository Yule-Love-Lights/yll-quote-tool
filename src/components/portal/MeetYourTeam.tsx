// About Yule Love Lights — company story, credential chips, and the team
// photo. Replaces the old single-person "Led by Naldo" bio: Naldo asked to
// lead with the company, not the individual. The founder is still named
// inside the bio copy; the friendly "Naldo" short form lives in the CTAs.

import Image from 'next/image';
import { ShieldCheck } from 'lucide-react';

export type MeetYourTeamProps = {
  photo: string;
  paragraphs: string[];
  badges?: string[];
};

export function MeetYourTeam({ photo, paragraphs, badges = [] }: MeetYourTeamProps) {
  return (
    <section aria-labelledby="portal-team-heading" className="w-full bg-[#FAF6EF]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 items-start">
          {/* Team photo */}
          <div className="md:col-span-5">
            <div className="relative w-full aspect-[3/2] rounded-2xl overflow-hidden ring-1 ring-[#E8DFCC] shadow-[0_10px_32px_-10px_rgba(31,27,22,0.3)]">
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
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
              About Yule Love Lights
            </p>
            <h2
              id="portal-team-heading"
              className="font-display text-[30px] md:text-[42px] leading-[1.1] font-semibold text-[#1F1B16]"
            >
              Long Island&apos;s family-owned lighting company.
            </h2>

            {badges.length > 0 && (
              <ul className="mt-5 flex flex-wrap gap-2" aria-label="Credentials">
                {badges.map((b) => (
                  <li
                    key={b}
                    className="text-[12px] font-semibold text-[#1F3D2B] bg-[#EDF2EC] border border-[#D7E3D5] rounded-full px-3 py-1"
                  >
                    {b}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6 space-y-4 text-[15px] md:text-[16px] text-[#3A3229] leading-[1.7] max-w-[65ch]">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>

            <div className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#FBF5E8] border border-[#E8D9B0] px-4 py-2.5">
              <ShieldCheck className="w-4 h-4 text-[#B8862A] shrink-0" aria-hidden />
              <span className="text-[14px] font-semibold text-[#1F1B16]">
                Backed by our Grinch-Proof Guarantee
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
