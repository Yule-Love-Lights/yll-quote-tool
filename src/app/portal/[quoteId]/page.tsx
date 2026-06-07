// Customer-facing quote approval portal — the sales-close page.
// Route: /portal/[quoteId] (the canonical customer URL).
//
// This is the SNOWGLOBE design: the home's photo becomes the product —
// tap a package, watch the lights come on. Wired to real DB data
// (loadPortalQuote) with the production approve flow: the StickyBottomBar
// POSTs to /api/quotes/[id]/approve (home.works + HighLevel) then routes
// to /portal/[id]/approved.
//
// The first screen is the InteractiveHero; below the fold it composes the
// dark-theme sections (WhatsIncluded, RiskReversal, …). The interactive
// pieces mount inside <SelectionProvider> so the hero, line-item toggles,
// and sticky price stay in sync.
//
// Data flow:
//   1. loadPortalQuote(quoteId) — DB → PortalQuote via the adapter.
//   2. If Supabase isn't configured (dev without .env), fall back to
//      MOCK_QUOTE so the page is still iterable on a fresh clone.
//   3. If Supabase is configured but the row doesn't exist, 404.

import { notFound } from 'next/navigation';
import { InteractiveHero } from '@/components/portal/snowglobe/InteractiveHero';
import { WalkthroughVideo } from '@/components/portal/snowglobe/WalkthroughVideo';
import { StickyBottomBar } from '@/components/portal/snowglobe/StickyBottomBar';
// Below-the-fold sections reuse the dark-theme components:
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
import { loadPortalQuote, PortalConfigError } from '@/lib/portal/loader';
import { pickInitialPackageId } from '@/lib/portal/derivePackages';
import type { PortalQuote } from '@/components/portal/types';

type Params = { quoteId: string };

// Google Business Profile reviews deep-link (browser-neutral).
const GMB_REVIEWS_URL =
  'https://www.google.com/search?q=Yule+Love+Lights#mpd=~18273026046139841384/customers/reviews';

// Fallback hero when a quote has no approved render yet (dev/preview only —
// real sent quotes always carry a render by the time a customer opens this).
const FALLBACK_HERO = '/references/Roslyn.webp';

// Resolve the active quote: real DB first, MOCK_QUOTE only as a dev
// fallback when Supabase isn't configured.
//
// notFound() throws a special "NEXT_NOT_FOUND" error that Next.js catches
// at the route boundary to render the 404 page. We must NOT call it from
// inside a try/catch — a generic catch would intercept it. Structure: do
// the load (which never throws now except PortalConfigError) inside the
// try, then call notFound() outside.
async function resolveQuote(quoteId: string): Promise<PortalQuote> {
  let real: PortalQuote | null = null;
  try {
    real = await loadPortalQuote(quoteId);
  } catch (err) {
    if (err instanceof PortalConfigError) return MOCK_QUOTE;
    throw err;
  }
  if (!real) notFound();
  return real;
}

// Team metadata is environment-driven (single source of truth) and
// otherwise falls back to the same defaults the mock data uses.
function resolveTeam() {
  const leaderName =
    process.env.NEXT_PUBLIC_PORTAL_LEADER_NAME?.trim() || MOCK_TEAM.leaderName;
  const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || MOCK_TEAM.phone;
  return {
    leaderName,
    phone,
    photo: MOCK_TEAM.photo,
    badges: MOCK_TEAM.badges,
    companyBio: MOCK_TEAM.companyBio,
  };
}

export default async function PortalPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { quoteId } = await params;
  const quote = await resolveQuote(quoteId);
  const team = resolveTeam();
  const initialPackageId = pickInitialPackageId(quote.packages);
  const heroAfter = quote.photo.after || FALLBACK_HERO;
  const heroAlt = quote.photo.alt || 'A Yule Love Lights install at dusk';

  return (
    <main className="relative w-full">
      <SelectionProvider
        packages={quote.packages}
        lineItems={quote.lineItems}
        roofline={quote.roofline}
        charges={quote.charges}
        minimumOrderSubtotal={quote.minimumOrderSubtotal}
        initialPackageId={initialPackageId}
      >
        {/* 1. InteractiveHero — the whole first screen is the product */}
        <InteractiveHero
          firstName={quote.customer.firstName}
          address={quote.customer.address}
          afterUrl={heroAfter}
          alt={heroAlt}
          packages={quote.packages}
          lineItemCount={quote.lineItems.length}
          design={quote.design}
        />

        {/* 2. Walkthrough video — global default or per-quote override */}
        {quote.video && <WalkthroughVideo video={quote.video} />}

        {/* 3. What's Included — line-item toggles feed the hero + sticky price */}
        <WhatsIncluded items={quote.lineItems} />

        {/* 4. Risk Reversal */}
        <RiskReversal />

        {/* 5. What Happens Next */}
        <WhatHappensNext />

        {/* 6. About Yule Love Lights — company story + credentials */}
        <MeetYourTeam
          photo={team.photo}
          paragraphs={team.companyBio}
          badges={team.badges}
        />

        {/* 7. Google Reviews */}
        <GoogleReviews
          rating={4.9}
          totalReviews={187}
          reviews={MOCK_REVIEWS}
          reviewsUrl={GMB_REVIEWS_URL}
        />

        {/* 8. Gallery */}
        <Gallery items={MOCK_GALLERY_ITEMS} />

        {/* 9. Philanthropy */}
        <Philanthropy />

        {/* 10. FAQ */}
        <FAQ items={MOCK_FAQ} />

        {/* 11. Personal contact */}
        <PersonalContact
          leaderName={team.leaderName}
          photo={team.photo}
          phone={team.phone}
        />

        {/* 12. Disclaimer */}
        <Disclaimer />

        {/* Sticky floating pill bar — real approve flow, always last in tree */}
        <StickyBottomBar quoteId={quoteId} />
      </SelectionProvider>
    </main>
  );
}
