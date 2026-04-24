// Portal v4 — Private Concierge. The fourth design direction.
// Route: /portal-concierge/[quoteId]
//
// v1 at /portal, v2 at /portal-dark, v6 at /portal-snowglobe are all
// untouched. All versions read the same MOCK_QUOTE so copy cannot drift
// between them.
//
// v4 positioning: private client dossier, not a sales portal.
// Aesthetic: Ralph Lauren country club Christmas — Racing Green + Cream
// + two reds (Christmas red for CTAs, oxblood for accents) + antique brass
// for ornament. Cormorant Garamond display + Inter body. Slow motion,
// generous whitespace, Roman numeral section markers, editorial pull-
// quotes instead of testimonial cards.

import { SelectionProvider } from '@/components/portal/SelectionContext';
import {
  MOCK_QUOTE,
  MOCK_GALLERY_ITEMS,
  MOCK_REVIEWS,
  MOCK_FAQ,
  MOCK_TEAM,
} from '@/components/portal/mockQuote';

import { CoverPage } from '@/components/portal/concierge/CoverPage';
import { Property } from '@/components/portal/concierge/Property';
import { ConciergeWalkthrough } from '@/components/portal/concierge/ConciergeWalkthrough';
import { Proposal } from '@/components/portal/concierge/Proposal';
import { IncludedInService } from '@/components/portal/concierge/IncludedInService';
import { TermsOfService } from '@/components/portal/concierge/TermsOfService';
import { YourConcierge } from '@/components/portal/concierge/YourConcierge';
import { RecentService } from '@/components/portal/concierge/RecentService';
import { PortfolioGallery } from '@/components/portal/concierge/PortfolioGallery';
import { Enquiries } from '@/components/portal/concierge/Enquiries';
import { Engagement } from '@/components/portal/concierge/Engagement';
import { StickyPill } from '@/components/portal/concierge/StickyPill';
import { Disclaimer } from '@/components/portal/concierge/Disclaimer';

type Params = { quoteId: string };

export default async function PortalConciergePage({
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
        {/* I — Cover */}
        <CoverPage
          clientName={`The ${quote.customer.fullName.split(' ').slice(-1)[0]} Family`}
          address={quote.customer.address}
          quoteRef={quote.id}
        />

        {/* II — The Property */}
        <Property
          afterUrl={quote.photo.after}
          alt={quote.photo.alt}
          address={quote.customer.address}
        />

        {/* III — Walkthrough (letter from concierge) */}
        {quote.video && <ConciergeWalkthrough video={quote.video} />}

        {/* IV — The Proposal (numbered packages) */}
        <Proposal packages={quote.packages} lineItems={quote.lineItems} />

        {/* V — Included in service (line-item toggles) */}
        <IncludedInService items={quote.lineItems} />

        {/* VI — Terms of service */}
        <TermsOfService />

        {/* VII — Your concierge (Naldo bio) */}
        <YourConcierge
          leaderName={MOCK_TEAM.leaderName}
          title={MOCK_TEAM.title}
          subtitle={MOCK_TEAM.subtitle}
          photo={MOCK_TEAM.photo}
          body={MOCK_TEAM.body}
        />

        {/* VIII — In recent service (editorial pull-quotes) */}
        <RecentService reviews={MOCK_REVIEWS} />

        {/* IX — Portfolio */}
        <PortfolioGallery items={MOCK_GALLERY_ITEMS} />

        {/* X — Enquiries (FAQ) */}
        <Enquiries items={MOCK_FAQ} />

        {/* XI — Engagement (approval CTA) */}
        <Engagement quoteId={quoteId} />

        {/* Footer disclaimer */}
        <Disclaimer quoteRef={quote.id} phone={MOCK_TEAM.phone} />

        {/* Floating sticky pill — present throughout */}
        <StickyPill />
      </SelectionProvider>
    </main>
  );
}
