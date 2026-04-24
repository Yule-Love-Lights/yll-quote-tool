// Portal v6 — SNOWGLOBE. Interactive-hero version where the home's
// photo becomes the product: tap a package, watch the lights come on.
// Route: /portal-snowglobe/[quoteId]
//
// v1 at /portal/[quoteId] and v2 at /portal-dark/[quoteId] are fully
// preserved. All three versions read the same MOCK_QUOTE so content
// can't drift between them.
//
// Below the fold v6 reuses most of v2's dark components — the v6
// differentiator is almost entirely about the hero experience and the
// tight minimal chrome (no TrustBar, no UrgencyBanner, no separate
// PackageCards section since the hero handles package selection).

import { InteractiveHero } from '@/components/portal/snowglobe/InteractiveHero';
import { WalkthroughVideo } from '@/components/portal/snowglobe/WalkthroughVideo';
import { StickyBottomBar } from '@/components/portal/snowglobe/StickyBottomBar';
// Reused from v2 dark:
import { WhatsIncluded } from '@/components/portal/dark/WhatsIncluded';
import { RiskReversal } from '@/components/portal/dark/RiskReversal';
import { WhatHappensNext } from '@/components/portal/dark/WhatHappensNext';
import { MeetYourTeam } from '@/components/portal/dark/MeetYourTeam';
import { GoogleReviews } from '@/components/portal/dark/GoogleReviews';
import { Gallery } from '@/components/portal/dark/Gallery';
import { Philanthropy } from '@/components/portal/dark/Philanthropy';
import { FAQ } from '@/components/portal/dark/FAQ';
import { PersonalContact } from '@/components/portal/dark/PersonalContact';
import { Disclaimer } from '@/components/portal/dark/Disclaimer';
import { SelectionProvider } from '@/components/portal/SelectionContext';
import {
  MOCK_QUOTE,
  MOCK_GALLERY_ITEMS,
  MOCK_REVIEWS,
  MOCK_FAQ,
  MOCK_TEAM,
} from '@/components/portal/mockQuote';

type Params = { quoteId: string };

export default async function PortalSnowglobePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { quoteId } = await params;
  const quote = MOCK_QUOTE;

  return (
    <main className="relative w-full">
      <SelectionProvider
        packages={quote.packages}
        lineItems={quote.lineItems}
        initialPackageId="B"
      >
        {/* 1. InteractiveHero — the whole first screen is the product */}
        <InteractiveHero
          firstName={quote.customer.firstName}
          address={quote.customer.address}
          afterUrl={quote.photo.after}
          alt={quote.photo.alt}
          packages={quote.packages}
          lineItemCount={quote.lineItems.length}
        />

        {/* 2. Walkthrough video — Naldo explains the quote (anchor
         * target from the hero's "Watch walkthrough" link) */}
        {quote.video && <WalkthroughVideo video={quote.video} />}

        {/* 3. What's Included — line-item toggles; selections feed back
         * into the hero's Custom tier and the sticky price */}
        <WhatsIncluded items={quote.lineItems} />

        {/* 4. Risk Reversal */}
        <RiskReversal />

        {/* 5. What Happens Next */}
        <WhatHappensNext />

        {/* 6. Meet Your Team */}
        <MeetYourTeam
          leaderName={MOCK_TEAM.leaderName}
          title={MOCK_TEAM.title}
          subtitle={MOCK_TEAM.subtitle}
          photo={MOCK_TEAM.photo}
          body={MOCK_TEAM.body}
        />

        {/* 7. Google Reviews */}
        <GoogleReviews rating={4.9} totalReviews={187} reviews={MOCK_REVIEWS} />

        {/* 8. Gallery */}
        <Gallery items={MOCK_GALLERY_ITEMS} />

        {/* 9. Philanthropy */}
        <Philanthropy />

        {/* 10. FAQ */}
        <FAQ items={MOCK_FAQ} />

        {/* 11. Personal contact */}
        <PersonalContact
          leaderName={MOCK_TEAM.leaderName}
          photo={MOCK_TEAM.photo}
          phone={MOCK_TEAM.phone}
        />

        {/* 12. Disclaimer */}
        <Disclaimer />

        {/* Sticky floating pill bar — v6 variant, always in tree last */}
        <StickyBottomBar quoteId={quoteId} />
      </SelectionProvider>
    </main>
  );
}
