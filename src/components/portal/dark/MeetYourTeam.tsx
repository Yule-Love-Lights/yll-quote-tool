// Portal v2 DARK — Meet Your Team. Portrait in gold ring (the "lit
// up" trust anchor) + italic display quote. Chick-fil-A credential
// remains the key emphasis.

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
      aria-labelledby="portal-dark-team-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="flex flex-col md:flex-row items-start md:items-center gap-8 md:gap-14">
          <div className="relative shrink-0">
            <div className="relative w-[140px] h-[140px] md:w-[200px] md:h-[200px] rounded-full overflow-hidden ring-2 ring-[#E8B862]/60 shadow-[0_0_32px_rgba(232,184,98,0.25),0_12px_40px_rgba(0,0,0,0.6)]">
              <Image
                src={photo}
                alt={`Portrait of ${leaderName}`}
                fill
                sizes="(max-width: 768px) 140px, 200px"
                className="object-cover"
              />
            </div>
            {/* Subtle outer glow ring */}
            <span
              aria-hidden
              className="absolute inset-0 rounded-full pointer-events-none"
              style={{ boxShadow: '0 0 60px rgba(232,184,98,0.15)' }}
            />
          </div>

          <div className="flex-1 max-w-2xl">
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-2">
              Meet Your Team
            </p>
            <h2
              id="portal-dark-team-heading"
              className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
            >
              Led by {leaderName}.
            </h2>
            <p className="mt-2 text-[15px] md:text-[16px] text-[#A89F87]">
              {title}
            </p>
            <p className="mt-5 font-display italic text-[19px] md:text-[22px] text-[#E0D7C1] leading-[1.5]">
              {subtitle} {body}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
