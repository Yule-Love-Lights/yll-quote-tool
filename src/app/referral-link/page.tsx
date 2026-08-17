// Self-serve referral link request (naldo/referral-self-serve).
//
// Public page: quote.yulelovelights.com/referral-link. The owner is emailing
// his whole GHL list an invitation to generate their own referral link.
// Most recipients are leads who never bought: no `customers` row, no quote,
// and (before this page) no way to get a link at all. Server component: no
// per-request data to read, so this stays a plain static shell around the
// client form. See src/app/api/referrals/request-link/route.ts for the
// uniform-response contract the form's confirmation copy is written around
// (it can never reveal whether an email matched a real contact).

import type { Metadata } from 'next';
import { ReferralLinkForm } from './ReferralLinkForm';

export const metadata: Metadata = {
  title: 'Get Your Referral Link | Yule Love Lights',
  description: 'Type your email to get your personal Yule Love Lights referral link.',
  robots: { index: false, follow: false },
};

export default function ReferralLinkPage() {
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
            Send friends and neighbors our way. When they book, you get $125 off your next job. They get 2 free
            16&quot; spritzers.
          </p>
        </div>
        <ReferralLinkForm />
      </div>
    </main>
  );
}
