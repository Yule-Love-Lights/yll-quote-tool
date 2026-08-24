// Portal v2 DARK — booked-page referral section (ledger #41). Locked product
// (Naldo, S30): the referrer gets a credit for every friend who books,
// stackable, good toward ANY Yule Love Lights service (consumeCredits in
// src/lib/referrals.ts carries no service-type filter); the friend gets two
// free spritzers on their first booked install. Pure presentational
// component (no Next.js / server imports) so it renders and is
// unit-testable without the surrounding page shell.
//
// naldo/referral-link-preview: the friend's spritzer reward is dollarized
// (spritzerRetailValueUsd, derived from the quote builder's own per-size
// rate, never a hardcoded number). "Spritzers" is trade jargon with no
// meaning to a homeowner on its own. Computed locally from the count/size
// props already passed in, rather than adding a new prop, so this component
// stays a drop-in replacement for its existing caller.

import { ReferralLinkCopy } from './ReferralLinkCopy';
import { ReferralShareButton } from './ReferralShareButton';
import { QrSvg } from '@/components/QrSvg';
import { formatUsd } from '@/components/portal/format';
import { spritzerRetailValueUsd } from '@/lib/referralSpritzerValue';

export function ReferralSection({
  referralLink,
  creditUsd,
  spritzerCount,
  spritzerSizeInches,
  qrSvg,
}: {
  /** The referrer's personal /refer/<code> link, or null when this quote has
   *  no linked customer row — the section falls back to copy-only. */
  referralLink: string | null;
  creditUsd: number;
  spritzerCount: number;
  spritzerSizeInches: number;
  /** Server-generated inline QR SVG for `referralLink` (growth feature 2),
   *  or null when it wasn't generated (no link, or generation failed —
   *  fail-open, the link + copy + share still work without it). */
  qrSvg?: string | null;
}) {
  const spritzerValueUsd = spritzerRetailValueUsd(spritzerCount, spritzerSizeInches);
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
              {formatUsd(creditUsd)} credit
            </span>{' '}
            toward any job.
          </h2>
          <p className="mt-4 text-[16px] md:text-[17px] text-[#A89F87] leading-[1.65]">
            You get {formatUsd(creditUsd)} credit for every friend who books an install, good
            toward any Yule Love Lights service: holiday, permanent, event and wedding lighting,
            or bistro. It stacks, so there is no limit on how many friends you refer. Your friend
            gets {formatUsd(spritzerValueUsd)} in free lighting on their first booked install,{' '}
            {spritzerCount} staked spotlights for their yard ({spritzerSizeInches}&quot;
            spritzers).
          </p>
          {referralLink ? (
            <>
              <p className="mt-6 text-[13px] md:text-[14px] font-semibold text-[#E0D7C1]">
                Share your personal link:
              </p>
              <ReferralLinkCopy
                link={referralLink}
                after={
                  <ReferralShareButton
                    link={referralLink}
                    spritzerCount={spritzerCount}
                    spritzerSizeInches={spritzerSizeInches}
                    spritzerValueUsd={spritzerValueUsd}
                  />
                }
              />
              {qrSvg && (
                <div className="mt-4 flex items-center gap-3">
                  <QrSvg svg={qrSvg} className="w-16 h-16" />
                  <p className="text-[12px] text-[#7B7361]">or scan to share</p>
                </div>
              )}
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
