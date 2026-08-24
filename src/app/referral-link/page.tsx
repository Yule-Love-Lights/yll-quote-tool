// Self-serve referral link request (naldo/referral-self-serve +
// naldo/referral-link-personalized).
//
// Public page: quote.yulelovelights.com/referral-link. The owner is emailing
// his whole GHL list an invitation to generate their own referral link.
// Most recipients are leads who never bought: no `customers` row, no quote,
// and (before this page) no way to get a link at all. Server component: no
// per-request data to read, so this stays a plain static shell around the
// client form. See src/app/api/referrals/request-link/route.ts for the
// uniform-response contract the form's confirmation copy is written around
// (it can never reveal whether an email matched a real contact).
//
// Review fix 2: flag-gated (REFERRAL_SELF_SERVE_ENABLED, ships OFF), same
// notFound()-when-off pattern as src/app/estimate/page.tsx. This is the
// feature's rollback lever, see referralSelfServeFlag.ts.
//
// naldo/referral-link-personalized: optional ?c=<ghl-contact-id>, set by a
// GoHighLevel merge field in the owner's campaign link so each recipient's
// own contact id rides along, no typing required. CRITICAL: this component
// makes NO GoHighLevel call and NO write on load, on purpose: email clients
// and security appliances prefetch links, and if merely loading this page
// minted a code or stamped a CRM field, every recipient would be enrolled
// without ever clicking anything. `c` is only read and handed down as a
// plain string prop; all work happens later, from an explicit click, inside
// the API route. Mirrors src/app/quote/new/page.tsx's own ghlContactId
// param: "raw and unvalidated here", the client form and the route do the
// sanitizing.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isReferralSelfServeEnabled } from '@/lib/referralSelfServeFlag';
import { REFERRAL_CREDIT_USD, REFERRAL_CREDIT_EXPIRY_YEARS, REFERRAL_FRIEND_SPRITZERS } from '@/lib/referrals';
import { spritzerRetailValueUsd } from '@/lib/referralSpritzerValue';
import { CompactTrustRow } from '@/components/portal/dark/CompactTrustRow';
import { formatUsd } from '@/components/portal/format';
import { PhoneFrame } from './PhoneFrame';
import { ReferralLinkForm } from './ReferralLinkForm';

// naldo/referral-link-preview: "2 free 16 inch spritzers" is trade jargon a
// homeowner has no way to price on their own. Dollarized once here, from the
// quote builder's own per-size rate, never a separate hardcoded number
// (mirrors src/app/refer/[code]/page.tsx's own SPRITZER_VALUE_USD).
const SPRITZER_VALUE_USD = spritzerRetailValueUsd(
  REFERRAL_FRIEND_SPRITZERS.count,
  REFERRAL_FRIEND_SPRITZERS.sizeInches,
);

// The flag is a runtime server env read, never statically pre-render this page.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Get Your Referral Link | Yule Love Lights',
  description: 'Type your email to get your personal Yule Love Lights referral link.',
  robots: { index: false, follow: false },
};

export default async function ReferralLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  if (!isReferralSelfServeEnabled()) notFound();
  const { c } = await searchParams;
  const contactId = c?.trim() || undefined;
  return (
    <main className="relative min-h-screen w-full bg-[#060B0F] flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-4">
            Yule Love Lights
          </p>
          <h1 className="font-display text-[32px] leading-[1.1] md:text-[42px] md:leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.02em]">
            Get your referral link
          </h1>
          <p className="mt-4 text-[16px] md:text-[17px] text-[#E0D7C1] leading-[1.6]">
            Send friends and neighbors our way. When they book, you get {formatUsd(REFERRAL_CREDIT_USD)}{' '}
            credit toward any Yule Love Lights service, holiday, permanent, event and wedding
            lighting, or bistro. They get {formatUsd(SPRITZER_VALUE_USD)} in free lighting on their
            first install: {REFERRAL_FRIEND_SPRITZERS.count} staked spotlights for their yard.
          </p>
          {/* Trust row (naldo/referral-link-preview, PIECE 1): the same
              compact rating / license / guarantee signals the referral
              landing page itself shows above its fold (ReferHero.tsx), so
              someone deciding whether to bother generating a link sees the
              same proof their friend will see. Kept to this one line on
              purpose: this page has a single job, and the heavier trust
              sections (logo marquee, review carousel, guarantee cards) are
              built to carry a stranger through a whole buying decision,
              which is not what a returning contact clicking one link needs. */}
          <div className="mt-6">
            <CompactTrustRow />
          </div>
        </div>

        {/* Sample preview (naldo/referral-link-preview, PIECE 3a): the
            enticement. Shows the no-database /refer/preview route (PIECE 2)
            in a phone-shaped frame so a visitor sees exactly what their
            friend receives before they bother generating anything.
            Review fix 1: the caption used to say "This is what your friend
            sees", which is only true for a recipient with no approved
            design on file. resolveHero (src/app/refer/[code]/page.tsx)
            shows a referrer's OWN rendered house whenever they have an
            approved quote with a photo and haven't opted out, so the
            wording now stays true for that group too, while still selling
            the idea to everyone else. */}
        <div className="mb-10 text-center">
          <PhoneFrame src="/refer/preview" title="A sample of what your friend receives" />
          <p className="mt-4 text-[13px] text-[#A89F87]">
            A sample of the page. If you already have a design with us, your friend sees your
            own home lit up instead.
          </p>
        </div>

        <ReferralLinkForm
          contactId={contactId}
          creditUsd={REFERRAL_CREDIT_USD}
          creditExpiryYears={REFERRAL_CREDIT_EXPIRY_YEARS}
          spritzerCount={REFERRAL_FRIEND_SPRITZERS.count}
          spritzerSizeInches={REFERRAL_FRIEND_SPRITZERS.sizeInches}
          spritzerValueUsd={SPRITZER_VALUE_USD}
        />
      </div>
    </main>
  );
}
