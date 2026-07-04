// Customer-facing quote approval portal — the sales-close page.
// Route: /portal/[quoteId] (the canonical customer URL).
//
// This is the SNOWGLOBE design: the home's photo becomes the product —
// tap a package, watch the lights come on. Wired to real DB data
// (loadPortalQuote) with the approve flow: the StickyBottomBar POSTs to
// /api/quotes/[id]/approve (freezes the approval snapshot, then texts/emails
// the customer and emails staff to collect the 50% deposit — pre-Valor
// placeholder) then routes to /portal/[id]/approved.
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
import { BookedBanner } from '@/components/portal/snowglobe/BookedBanner';
// Below-the-fold sections reuse the dark-theme components:
import { WhatsIncluded } from '@/components/portal/dark/WhatsIncluded';
import { LightColorPicker } from '@/components/portal/dark/LightColorPicker';
import { RiskReversal } from '@/components/portal/dark/RiskReversal';
import { RiskReversalPermanent } from '@/components/portal/dark/RiskReversalPermanent';
import { WhatHappensNextPermanent } from '@/components/portal/dark/WhatHappensNextPermanent';
import { EventSchedule } from '@/components/portal/dark/EventSchedule';
import { EventSuggestions } from '@/components/portal/dark/EventSuggestions';
import { PhotoGallery } from '@/components/portal/dark/PhotoGallery';
import { WhatHappensNext } from '@/components/portal/dark/WhatHappensNext';
import { MeetYourTeam } from '@/components/portal/dark/MeetYourTeam';
import { GoogleReviews } from '@/components/portal/dark/GoogleReviews';
import { Gallery } from '@/components/portal/dark/Gallery';
import { Philanthropy } from '@/components/portal/dark/Philanthropy';
import { FAQ } from '@/components/portal/dark/FAQ';
import { PersonalContact } from '@/components/portal/dark/PersonalContact';
import { TrustSection } from '@/components/portal/dark/TrustSection';
import { Disclaimer } from '@/components/portal/dark/Disclaimer';
import { SelectionProvider } from '@/components/portal/SelectionContext';
import { QuoteViewTracker } from '@/components/portal/QuoteViewTracker';
import {
  MOCK_QUOTE,
  MOCK_GALLERY_ITEMS,
  MOCK_REVIEWS,
  MOCK_FAQ,
  EVENT_FAQ,
  MOCK_TEAM,
} from '@/components/portal/mockQuote';
import { loadPortalQuote, PortalConfigError } from '@/lib/portal/loader';
import { pickInitialPackageId } from '@/lib/portal/derivePackages';
import { isPortalActionable } from '@/lib/quoteStatus';
import type { PortalQuote } from '@/components/portal/types';
import { getAppSettings } from '@/lib/appSettings';
import { fetchGoogleReviews } from '@/lib/googleReviews';
import { isValorCheckoutEnabled } from '@/lib/integrations/valorCheckout';

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
  // Perf fix (audit W4-005): these three loads are independent of each other
  // (reviews/settings don't depend on the quote), so run them concurrently
  // instead of stacking their round-trips. resolveQuote's notFound() call
  // still propagates normally through Promise.all (it isn't wrapped in a
  // try/catch here), matching the pre-existing "notFound() must not be
  // swallowed" contract documented on resolveQuote itself.
  const [quote, liveReviews, appSettings] = await Promise.all([
    resolveQuote(quoteId),
    fetchGoogleReviews(),
    getAppSettings(),
  ]);
  const team = resolveTeam();

  // Audit fix (empty-quote-portal-guard): a quote row with no line items
  // (old/partially-saved rows the adapter tolerates → lineItems: []) would
  // otherwise render packages with nothing to select and a permanently-disabled
  // Approve nudging "Select at least one item to continue" — a customer-facing
  // dead-end. Guard at the page level: show a branded "being finalized" state
  // with the team phone instead of the un-actionable approve UI.
  if (quote.lineItems.length === 0) {
    return (
      <main className="relative flex min-h-screen w-full flex-col items-center justify-center bg-slate-950 px-6 py-24 text-center text-slate-100">
        <QuoteViewTracker quoteId={quoteId} />
        <h1 className="text-2xl font-semibold sm:text-3xl">
          Your quote is being finalized
        </h1>
        <p className="mt-4 max-w-md text-base text-slate-300">
          {quote.customer.firstName
            ? `Thanks, ${quote.customer.firstName} — `
            : 'Thanks — '}
          we&apos;re putting the finishing touches on your design and we&apos;ll
          be in touch shortly.
        </p>
        <p className="mt-6 text-sm text-slate-400">
          Have a question in the meantime? Call us at{' '}
          <a
            href={`tel:${team.phone.replace(/[^\d+]/g, '')}`}
            className="font-medium text-amber-300 underline-offset-2 hover:underline"
          >
            {team.phone}
          </a>
          .
        </p>
      </main>
    );
  }
  // Bug fix (#83 B3 UI): a quote in a terminal branch (declined/cancelled/lost)
  // or under revision (changes_requested) must NOT show the approve+pay flow —
  // the customer could otherwise pay/approve a quote staff already killed or are
  // revising. The server already rejects it (the /approve status gate + /pay's
  // approve-first guard); this is the matching UI gate. Skip the gate once the
  // customer has approved (`quote.approval`) so a booked quote later marked
  // 'cancelled' still renders its confirmation/booked view rather than this
  // neutral notice. Mirrors the empty-quote guard above (page-level read-only
  // fallback before the interactive UI mounts).
  if (!quote.approval && !isPortalActionable(quote.quoteStatus)) {
    const isRevising = quote.quoteStatus === 'changes_requested';
    return (
      <main className="relative flex min-h-screen w-full flex-col items-center justify-center bg-slate-950 px-6 py-24 text-center text-slate-100">
        <QuoteViewTracker quoteId={quoteId} />
        <h1 className="text-2xl font-semibold sm:text-3xl">
          {isRevising ? 'Your quote is being updated' : 'This quote is no longer available'}
        </h1>
        <p className="mt-4 max-w-md text-base text-slate-300">
          {quote.customer.firstName ? `Thanks, ${quote.customer.firstName} — ` : 'Thanks — '}
          {isRevising
            ? "we're revising your quote and we'll send you the updated version shortly."
            : "this quote has been closed. If you'd like to move forward, just reach out and we'll be happy to help."}
        </p>
        <p className="mt-6 text-sm text-slate-400">
          Questions? Call us at{' '}
          <a
            href={`tel:${team.phone.replace(/[^\d+]/g, '')}`}
            className="font-medium text-amber-300 underline-offset-2 hover:underline"
          >
            {team.phone}
          </a>
          .
        </p>
      </main>
    );
  }

  // #22 — live Google reviews (rating + featured 5-star testimonials). Null when
  // GOOGLE_PLACE_ID isn't set, the Places API call fails, or Google returns no
  // usable reviews → the section keeps its mock block below. (Fetched above,
  // in parallel with the quote + app settings — audit W4-005.)
  // #43 — once the customer has approved, the portal reads as BOOKED rather than
  // re-shoppable: a banner up top + the sticky bar's Approve CTA becomes a
  // "View confirmation" link (the approval snapshot drives /approved).
  const isApproved = !!quote.approval;
  // #38 — read the customer-checkout flag on the server (request time), so the
  // sticky bar's Approve either opens the embedded deposit checkout (on) or
  // routes to the booked page (off). Server-read avoids a stale baked value.
  const checkoutEnabled = isValorCheckoutEnabled();
  // #38 — with online checkout ON, "booked" means the deposit was actually PAID
  // (the webhook stamped deposit_paid_at). Approval alone is NOT booked — an
  // approved-but-unpaid customer still owes the deposit and must be able to pay.
  // With checkout OFF (the placeholder flow), approval is the end state.
  const isPaid = !!quote.approval?.depositPaidAt;
  // #93 — a TEST quote uses the same "booked = deposit PAID" logic as checkout-on
  // (the simulated deposit stamps deposit_paid_at), so an approved-not-yet-paid
  // test quote still shows the "Simulate deposit paid" bar instead of jumping
  // straight to booked. Real quotes are unchanged.
  const isBooked = checkoutEnabled || quote.isTest ? isPaid : isApproved;
  // Global app settings (#32) — applied to the live design render so the customer
  // sees the configured palette + render tunables (e.g. spritzer density).
  // (Fetched above, in parallel with the quote + reviews — audit W4-005.)
  // Fallback default package — escalates past B to a tier that clears the
  // $1,000 minimum so a no-recommendation quote opens approvable (#12).
  const initialPackageId = pickInitialPackageId(
    quote.packages,
    quote.lineItems,
    quote.minimumOrderSubtotal,
  );
  const heroAfter = quote.photo.after || FALLBACK_HERO;
  const heroAlt = quote.photo.alt || 'A Yule Love Lights install at dusk';

  // Recommended initial selection (#12): the "Our Recommendation" (D) package is
  // populated upstream (applyOurRecommendation in the loader) with the staff-
  // recommended items + the recommended roofline. When it has items, open the
  // portal on that set (computeInitialSelection switches to custom 'D'); when
  // staff recommended nothing, D is the empty "Build Your Own" card and we fall
  // back to the package-seeded default (Tier 1 — see pickInitialPackageId).
  const ourRecommendation = quote.packages.find((p) => p.id === 'D');
  const initialSelectedItemIds =
    ourRecommendation && ourRecommendation.includedItemIds.length > 0
      ? ourRecommendation.includedItemIds
      : undefined;

  return (
    <main className="relative w-full">
      {/* #68 — records the customer's open (client-side, fire-and-forget). */}
      <QuoteViewTracker quoteId={quoteId} />
      {isBooked && (
        <BookedBanner quoteId={quoteId} approvedAt={quote.approval?.approvedAt} />
      )}
      <SelectionProvider
        packages={quote.packages}
        lineItems={quote.lineItems}
        roofline={quote.roofline}
        charges={quote.charges}
        minimumOrderSubtotal={quote.minimumOrderSubtotal}
        initialPackageId={initialPackageId}
        initialSelectedItemIds={initialSelectedItemIds}
        locked={isApproved}
        daylightAvailable={!!quote.design?.photoUrl}
        initialInstallTiming={quote.serviceType === 'permanent' ? 'none' : quote.installTiming}
        earlyInstallDiscountsHidden={appSettings.portal.hideEarlyInstallDiscounts}
        schemes={appSettings.swatches.schemes}
        buildableColorIds={appSettings.swatches.buildableColorIds}
      >
        {/* 1. InteractiveHero — the whole first screen is the product */}
        <InteractiveHero
          firstName={quote.customer.firstName}
          afterUrl={heroAfter}
          alt={heroAlt}
          packages={quote.packages}
          lineItemCount={quote.lineItems.length}
          design={quote.design}
          palette={appSettings.colors}
          renderSettings={appSettings.render}
          serviceType={quote.serviceType}
        />

        {/* 1.5 Light color picker (#48/#57) — moved out of the hero into a band
            below the packages so the swatches don't overlap the photo on a phone.
            Only when a design is linked (recolor needs a live scene). */}
        {quote.design && quote.serviceType !== 'permanent' && <LightColorPicker />}

        {/* 2. Walkthrough video — global default or per-quote override */}
        {quote.video && <WalkthroughVideo video={quote.video} />}

        {/* 3. What's Included — line-item toggles feed the hero + sticky price.
            Also hosts the second on-page design render (#50) between the items
            and the add-ons (passes the design + app settings through). */}
        <WhatsIncluded
          items={quote.lineItems}
          design={quote.design}
          palette={appSettings.colors}
          renderSettings={appSettings.render}
          serviceType={quote.serviceType}
        />

        {/* 3.4 Your Event Schedule (#96) — the 3 staff-entered dates as a timeline;
            event quotes only, and only when at least one date is set. */}
        {quote.serviceType === 'event' && quote.eventSchedule && (
          <EventSchedule schedule={quote.eventSchedule} />
        )}

        {/* 3.45 Soft add-on suggestions (#96) — event quotes only, when present. */}
        {quote.serviceType === 'event' && quote.eventSuggestions && quote.eventSuggestions.length > 0 && (
          <EventSuggestions suggestions={quote.eventSuggestions} />
        )}

        {/* 3.5 All photos, lit, at once (#13 multi-image — 🧪 trial placement:
            between the totals box above and Your Protection below). Renders
            nothing for single-photo designs. */}
        {quote.design && (
          <PhotoGallery
            design={quote.design}
            palette={appSettings.colors}
            renderSettings={appSettings.render}
          />
        )}

        {/* 4. Risk Reversal — permanent gets the lifetime-warranty variant (#88);
             event/holiday branch their copy inside RiskReversal via serviceType (#96) */}
        {quote.serviceType === 'permanent' ? <RiskReversalPermanent /> : <RiskReversal serviceType={quote.serviceType} />}

        {/* 4.5 Trust / social proof (#70) — client partner + press marquees */}
        <TrustSection />

        {/* 5. What Happens Next — permanent drops takedown for year-round control (#88);
             event/holiday branch their copy inside WhatHappensNext via serviceType (#96) */}
        {quote.serviceType === 'permanent' ? <WhatHappensNextPermanent /> : <WhatHappensNext serviceType={quote.serviceType} />}

        {/* 6. About Yule Love Lights — company story + credentials */}
        <MeetYourTeam
          photo={team.photo}
          paragraphs={team.companyBio}
          badges={team.badges}
        />

        {/* 7. Google Reviews — live from the Google Business Profile (#22)
            when configured; mock block as the graceful fallback. liveReviews is
            all-or-nothing, so the headline rating and the testimonials always
            come from the same source (never live rating + mock quotes). */}
        <GoogleReviews
          rating={liveReviews?.rating ?? 4.9}
          totalReviews={liveReviews?.totalReviews ?? 187}
          reviews={liveReviews?.reviews ?? MOCK_REVIEWS}
          reviewsUrl={liveReviews?.reviewsUrl ?? GMB_REVIEWS_URL}
        />

        {/* 8. Gallery */}
        <Gallery items={MOCK_GALLERY_ITEMS} />

        {/* 9. Philanthropy */}
        <Philanthropy />

        {/* 10. FAQ — event quotes get event-specific Q&A (#96). */}
        <FAQ items={quote.serviceType === 'event' ? EVENT_FAQ : MOCK_FAQ} />

        {/* 11. Personal contact */}
        <PersonalContact
          leaderName={team.leaderName}
          photo={team.photo}
          phone={team.phone}
        />

        {/* 12. Disclaimer */}
        <Disclaimer />

        {/* Sticky floating pill bar — real approve flow, always last in tree */}
        <StickyBottomBar
          quoteId={quoteId}
          approved={isApproved}
          booked={isBooked}
          checkoutEnabled={checkoutEnabled}
          approvedDepositUsd={quote.approval?.depositUsd}
          isTest={quote.isTest}
          quoteStatus={quote.quoteStatus}
        />
      </SelectionProvider>
    </main>
  );
}
