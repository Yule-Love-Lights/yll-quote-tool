// Portal v2 DARK — the cinematic version of the customer approval page.
// Route: /portal-dark/[quoteId]
//
// Same information architecture as v1 (15 sections, same data seams),
// rebuilt on a dark festive theme where warm gold is the primary
// accent and red appears almost exclusively on the sticky CTA.
//
// v1 at /portal/[quoteId] is preserved and untouched. Both routes read
// from the same MOCK_QUOTE so content drift between versions is zero.
//
// Client boundaries (mount beneath the shared SelectionProvider):
//   - PackageCards, WhatsIncluded — package + line-item selection
//   - StickyBottomBar — reads live total + deposit for the CTA
//   - Hero — before/after crossfade toggle
//   - GoogleReviews / Gallery / FAQ — self-contained local state

import { TrustBar } from '@/components/portal/dark/TrustBar';
import { Hero } from '@/components/portal/dark/Hero';
import { WalkthroughVideo } from '@/components/portal/dark/WalkthroughVideo';
import { UrgencyBanner } from '@/components/portal/dark/UrgencyBanner';
import { PackageCards } from '@/components/portal/dark/PackageCards';
import { WhatsIncluded } from '@/components/portal/dark/WhatsIncluded';
import { RiskReversal } from '@/components/portal/dark/RiskReversal';
import { WhatHappensNext } from '@/components/portal/dark/WhatHappensNext';
import { MeetYourTeam } from '@/components/portal/dark/MeetYourTeam';
import { GoogleReviews } from '@/components/portal/dark/GoogleReviews';
import { Gallery } from '@/components/portal/dark/Gallery';
import { Philanthropy } from '@/components/portal/dark/Philanthropy';
import { FAQ } from '@/components/portal/dark/FAQ';
import { PersonalContact } from '@/components/portal/dark/PersonalContact';
import { StickyBottomBar } from '@/components/portal/dark/StickyBottomBar';
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

export default async function PortalDarkPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { quoteId } = await params;

  // In production: fetch the quote from the DB by quoteId. The mock
  // is returned for now so the page renders fully during iteration.
  const quote = MOCK_QUOTE;

  return (
    <main className="relative w-full">
      {/* 1. Press trust bar — quiet credibility strip above the hero */}
      <TrustBar />

      {/* 2. Hero — personalized headline floating over dusk photo */}
      <Hero
        firstName={quote.customer.firstName}
        beforeUrl={quote.photo.before}
        afterUrl={quote.photo.after}
        alt={quote.photo.alt}
      />

      {/* 2b. Walkthrough video — Naldo explains the quote. Renders only
       * when the quote has a video attached; silently hides otherwise. */}
      {quote.video && <WalkthroughVideo video={quote.video} />}

      {/* 3. Urgency / scarcity — honest, no fake countdowns */}
      <UrgencyBanner
        weeklyBookings={quote.weeklyBookings}
        bookedThroughDate={quote.seasonCapacity.bookedThroughDate}
      />

      {/* SelectionProvider wraps every piece that reads/writes the
       * live package + line-item selection. PackageCards, WhatsIncluded,
       * and StickyBottomBar all subscribe to this shared state. */}
      <SelectionProvider
        packages={quote.packages}
        lineItems={quote.lineItems}
        initialPackageId="B"
      >
        {/* 4. Package cards A/B/C/D — gold-glow selection, no red */}
        <PackageCards packages={quote.packages} />

        {/* 5. What's Included — per-line-item toggles */}
        <WhatsIncluded items={quote.lineItems} />

        {/* 6. Risk Reversal — six guarantees */}
        <RiskReversal />

        {/* 7. What Happens Next — 4-step install timeline */}
        <WhatHappensNext />

        {/* 8. Meet Your Team — Naldo + CFA credential */}
        <MeetYourTeam
          leaderName={MOCK_TEAM.leaderName}
          title={MOCK_TEAM.title}
          subtitle={MOCK_TEAM.subtitle}
          photo={MOCK_TEAM.photo}
          body={MOCK_TEAM.body}
        />

        {/* 9. Google Reviews carousel */}
        <GoogleReviews rating={4.9} totalReviews={187} reviews={MOCK_REVIEWS} />

        {/* 10. Gallery — editorial asymmetric grid with lightbox */}
        <Gallery items={MOCK_GALLERY_ITEMS} />

        {/* 11. Philanthropy strip — the one emotional red moment */}
        <Philanthropy />

        {/* 12. FAQ accordion */}
        <FAQ items={MOCK_FAQ} />

        {/* 13. Personal contact — gold phone number, glow text-shadow */}
        <PersonalContact
          leaderName={MOCK_TEAM.leaderName}
          photo={MOCK_TEAM.photo}
          phone={MOCK_TEAM.phone}
        />

        {/* 15. Disclaimer — muted text, spacer for sticky bar */}
        <Disclaimer />

        {/* 14. Sticky bottom CTA — ALWAYS last in tree so it overlays
         * everything. Reads live total+deposit from context. THE one
         * place red is the primary color in this theme. */}
        <StickyBottomBar quoteId={quoteId} />
      </SelectionProvider>
    </main>
  );
}
