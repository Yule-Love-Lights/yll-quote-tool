// Portal v2 DARK — booked-page referral section (ledger #41). Locked product
// (Naldo, S30): the referrer gets a next-season credit for every friend who
// books, stackable; the friend gets two free spritzers on their first booked
// install. Pure presentational component (no Next.js / server imports) so it
// renders and is unit-testable without the surrounding page shell.

import { ReferralLinkCopy } from './ReferralLinkCopy';
import { formatUsd } from '@/components/portal/format';

export function ReferralSection({
  referralLink,
  creditUsd,
  spritzerCount,
  spritzerSizeInches,
}: {
  /** The referrer's personal /refer/<code> link, or null when this quote has
   *  no linked customer row — the section falls back to copy-only. */
  referralLink: string | null;
  creditUsd: number;
  spritzerCount: number;
  spritzerSizeInches: number;
}) {
  return (
    <section aria-labelledby="snow-approved-referral" className="w-full bg-[#060B0F]">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-3">
            Want to help a neighbor?
          </p>
          <h2
            id="snow-approved-referral"
            className="font-display text-[28px] md:text-[42px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            Refer a neighbor, get{' '}
            <span className="text-[#FFB744]" style={{ textShadow: '0 0 22px rgba(255,183,68,0.35)' }}>
              {formatUsd(creditUsd)} off
            </span>{' '}
            next season.
          </h2>
          <p className="mt-4 text-[16px] md:text-[17px] text-[#A89F87] leading-[1.65]">
            You get {formatUsd(creditUsd)} off your next season for every friend who books an
            install. It stacks, so there is no limit on how many friends you refer. Your friend
            gets {spritzerCount} free {spritzerSizeInches}&quot; spritzers on their first booked
            install.
          </p>
          {referralLink ? (
            <>
              <p className="mt-6 text-[13px] md:text-[14px] font-semibold text-[#E0D7C1]">
                Share your personal link:
              </p>
              <ReferralLinkCopy link={referralLink} />
            </>
          ) : (
            <p className="mt-6 text-[16px] md:text-[17px] text-[#A89F87] leading-[1.65]">
              Tell them to mention your name when they call us, and we will credit your account
              once they book.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
