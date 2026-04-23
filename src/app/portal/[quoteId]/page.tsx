// Customer-facing quote approval portal — the sales-close page.
// Route: /portal/[quoteId]
//
// This page is a Server Component that composes the 15 sections in
// the order defined in the spec. The only client boundaries are the
// interactive pieces that mount inside <SelectionProvider>:
//   - PackageCards (reads + writes package state)
//   - WhatsIncluded (reads + writes line-item state)
//   - StickyBottomBar (reads total + deposit for the live CTA)
//   - Hero (before/after toggle — self-contained local state)
//   - GoogleReviews / Gallery / FAQ (self-contained local state)
//
// Mock data is injected from MOCK_QUOTE — the adapter seam for the
// real DB lives in src/components/portal/mockQuote.ts.

import { TrustBar } from '@/components/portal/TrustBar';
import { Hero } from '@/components/portal/Hero';
import { UrgencyBanner } from '@/components/portal/UrgencyBanner';
import { PackageCards } from '@/components/portal/PackageCards';
import { WhatsIncluded } from '@/components/portal/WhatsIncluded';
import { RiskReversal } from '@/components/portal/RiskReversal';
import { WhatHappensNext } from '@/components/portal/WhatHappensNext';
import { MeetYourTeam } from '@/components/portal/MeetYourTeam';
import { GoogleReviews } from '@/components/portal/GoogleReviews';
import { Gallery } from '@/components/portal/Gallery';
import { Philanthropy } from '@/components/portal/Philanthropy';
import { FAQ } from '@/components/portal/FAQ';
import { PersonalContact } from '@/components/portal/PersonalContact';
import { StickyBottomBar } from '@/components/portal/StickyBottomBar';
import { Disclaimer } from '@/components/portal/Disclaimer';
import { SelectionProvider } from '@/components/portal/SelectionContext';
import {
  MOCK_QUOTE,
  MOCK_GALLERY_ITEMS,
  MOCK_REVIEWS,
  MOCK_FAQ,
  MOCK_TEAM,
} from '@/components/portal/mockQuote';

type Params = { quoteId: string };

export default async function PortalPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { quoteId } = await params;

  // In production: fetch the quote from the DB by quoteId. For now
  // the mock is returned regardless, so the page renders fully while
  // the portal is being iterated on.
  const quote = MOCK_QUOTE;

  return (
    <main className="relative w-full">
      {/* 1. Press trust bar — quiet credibility strip above the hero */}
      <TrustBar />

      {/* 2. Hero — personalized headline + before/after render */}
      <Hero
        firstName={quote.customer.firstName}
        beforeUrl={quote.photo.before}
        afterUrl={quote.photo.after}
        alt={quote.photo.alt}
      />

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
        {/* 4. Package cards A/B/C/D */}
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

        {/* 11. Philanthropy strip */}
        <Philanthropy />

        {/* 12. FAQ accordion */}
        <FAQ items={MOCK_FAQ} />

        {/* 13. Personal contact — Naldo's direct line */}
        <PersonalContact
          leaderName={MOCK_TEAM.leaderName}
          photo={MOCK_TEAM.photo}
          phone={MOCK_TEAM.phone}
        />

        {/* 15. Disclaimer — render caveat, small cream block */}
        <Disclaimer />

        {/* 14. Sticky bottom CTA — ALWAYS last in tree so it overlays
         * everything. Reads live total+deposit from context. */}
        <StickyBottomBar quoteId={quoteId} />
      </SelectionProvider>
    </main>
  );
}
