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
// Data flow:
//   1. loadPortalQuote(quoteId) — DB → PortalQuote via the adapter.
//   2. If Supabase isn't configured (dev without .env), fall back to
//      MOCK_QUOTE so the page is still iterable on a fresh clone.
//   3. If Supabase is configured but the row doesn't exist, 404.

import { notFound } from 'next/navigation';
import { TrustBar } from '@/components/portal/TrustBar';
import { Hero } from '@/components/portal/Hero';
import { WalkthroughVideo } from '@/components/portal/WalkthroughVideo';
import { UrgencyBanner } from '@/components/portal/UrgencyBanner';
import { PackageCards } from '@/components/portal/PackageCards';
import { PackageVariantGallery } from '@/components/portal/PackageVariantGallery';
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
import { loadPortalQuote, PortalConfigError } from '@/lib/portal/loader';
import { pickInitialPackageId } from '@/lib/portal/derivePackages';
import type { PortalQuote } from '@/components/portal/types';

type Params = { quoteId: string };

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
    if (err instanceof PortalConfigError) {
      // Dev mode without env vars — keep the page renderable.
      return MOCK_QUOTE;
    }
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
  const phone =
    process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || MOCK_TEAM.phone;
  return {
    leaderName,
    title: MOCK_TEAM.title,
    subtitle: MOCK_TEAM.subtitle,
    photo: MOCK_TEAM.photo,
    body: MOCK_TEAM.body,
    phone,
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

  // Hero hides when no photos exist on the quote yet (renders pipeline
  // hasn't produced an approved final). Rendering an empty <img> with
  // src="" would break LCP and trigger a console warning.
  const heroHasPhotos = quote.photo.before && quote.photo.after;

  return (
    <main className="relative w-full">
      {/* 1. Press trust bar — quiet credibility strip above the hero */}
      <TrustBar />

      {/* 2. Hero — personalized headline + before/after render */}
      {heroHasPhotos && (
        <Hero
          firstName={quote.customer.firstName}
          beforeUrl={quote.photo.before}
          afterUrl={quote.photo.after}
          alt={quote.photo.alt}
        />
      )}

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
        initialPackageId={initialPackageId}
      >
        {/* 4. Package cards A/B/C/D */}
        <PackageCards packages={quote.packages} />

        {/* 4b. Per-package preview gallery — renders only when variant
         * images have been generated and approved for this quote. Hides
         * itself silently when the variant batch hasn't been run. */}
        <PackageVariantGallery
          variantPhotos={quote.variantPhotos}
          alt={quote.photo.alt}
        />

        {/* 5. What's Included — per-line-item toggles */}
        <WhatsIncluded items={quote.lineItems} />

        {/* 6. Risk Reversal — six guarantees */}
        <RiskReversal />

        {/* 7. What Happens Next — 4-step install timeline */}
        <WhatHappensNext />

        {/* 8. Meet Your Team — Naldo + CFA credential */}
        <MeetYourTeam
          leaderName={team.leaderName}
          title={team.title}
          subtitle={team.subtitle}
          photo={team.photo}
          body={team.body}
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
          leaderName={team.leaderName}
          photo={team.photo}
          phone={team.phone}
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
