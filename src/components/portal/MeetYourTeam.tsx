// Meet Your Team — warmth + credibility. Portrait on the left,
// personal copy on the right. The Chick-fil-A credential is the key
// trust anchor so it's emphasized.

import Image from 'next/image';

export type MeetYourTeamProps = {
  leaderName: string;
  title: string;
  subtitle: string;
  photo: string;
  body: string;
};

export function MeetYourTeam({ leaderName, title, subtitle, photo, body }: MeetYourTeamProps) {
  return (
    <section
      aria-labelledby="portal-team-heading"
      className="w-full bg-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-12">
          <div className="relative w-[140px] h-[140px] md:w-[200px] md:h-[200px] shrink-0 rounded-full overflow-hidden ring-4 ring-[#FBF5E8] shadow-[0_8px_28px_-8px_rgba(31,27,22,0.25)]">
            <Image
              src={photo}
              alt={`Portrait of ${leaderName}`}
              fill
              sizes="(max-width: 768px) 140px, 200px"
              className="object-cover"
            />
          </div>

          <div className="flex-1">
            <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-2">
              Meet Your Team
            </p>
            <h2
              id="portal-team-heading"
              className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
            >
              Led by {leaderName}.
            </h2>
            <p className="mt-1 text-[15px] md:text-[16px] text-[#6B5F52]">
              {title}
            </p>
            <p className="mt-5 font-display italic text-[18px] md:text-[21px] text-[#3A3229] leading-[1.5] max-w-2xl">
              {subtitle} {body}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
