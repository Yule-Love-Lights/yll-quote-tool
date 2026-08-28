// Referral landing page (ledger #41). Public: no operator auth, gated only by
// the referral code in the URL (allowlisted in src/lib/auth/operatorGate.ts).
// Personal-link attribution half of the referral program; the "mention"
// half is a picker in the quote builder (src/components/quote/QuoteBuilder.tsx).
//
// Server component: resolves the code -> referrer, the hero (the referrer's
// own latest APPROVED install rendered lit up, honoring their photo opt-out,
// else a completed-work gallery photo for their service type), then hands
// static props to small client islands (the view-tracker, the lead form, the
// hero's onError fallback) plus the below-the-fold sections shared with the
// portal (reviews / gallery / steps / protection / FAQ / about / contact,
// referral page bug batch 2026-07-17, fix 3).

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getReferralByCode,
  REFERRAL_CREDIT_USD,
  REFERRAL_CREDIT_EXPIRY_YEARS,
  REFERRAL_FRIEND_SPRITZERS,
} from '@/lib/referrals';
import { spritzerRetailValueUsd } from '@/lib/referralSpritzerValue';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { getDesignByQuote } from '@/lib/designs';
import {
  galleryItemsFor,
  crossSellFor,
  MOCK_REVIEWS,
  MOCK_FAQ,
  EVENT_FAQ,
  PERMANENT_FAQ,
  BISTRO_FAQ,
  MOCK_TEAM,
} from '@/components/portal/mockQuote';
import { TrustSection } from '@/components/portal/dark/TrustSection';
import { GoogleReviews } from '@/components/portal/dark/GoogleReviews';
import { Gallery } from '@/components/portal/dark/Gallery';
import { WhatHappensNext } from '@/components/portal/dark/WhatHappensNext';
import { RiskReversal } from '@/components/portal/dark/RiskReversal';
import { FAQ } from '@/components/portal/dark/FAQ';
import { MeetYourTeam } from '@/components/portal/dark/MeetYourTeam';
import { PersonalContact } from '@/components/portal/dark/PersonalContact';
import { formatUsd } from '@/components/portal/format';
import { asServiceType, type ServiceType } from '@/lib/serviceType';
import { getAppSettings } from '@/lib/appSettings';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { fetchGoogleReviews } from '@/lib/googleReviews';
import { ReferralPageTracker } from './ReferralPageTracker';
import { ReferralForm } from './ReferralForm';
import { ReferHero, type HeroResolution } from './ReferHero';

// Google Business Profile reviews deep-link (browser-neutral): same fallback
// URL the portal uses (src/app/portal/[quoteId]/page.tsx GMB_REVIEWS_URL) when
// live reviews aren't configured.
const GMB_REVIEWS_URL =
  'https://www.google.com/search?q=Yule+Love+Lights#mpd=~18273026046139841384/customers/reviews';

// naldo/referral-link-preview: "2 free 16 inch spritzers" is trade jargon a
// homeowner has no way to price on their own. Dollarized once here, from the
// quote builder's own per-size rate, never a separate hardcoded number.
const SPRITZER_VALUE_USD = spritzerRetailValueUsd(
  REFERRAL_FRIEND_SPRITZERS.count,
  REFERRAL_FRIEND_SPRITZERS.sizeInches,
);

// #41 adversarial-review LOW fix: this page is personalized per referral code
// (a different customer's hero photo + gallery fallback each time). Force
// dynamic rendering so it's never statically cached/served cross-referrer.
export const dynamic = 'force-dynamic';

type Params = { code: string };

function firstNameOf(name: string | null): string {
  if (!name) return 'A neighbor';
  const first = name.trim().split(/\s+/)[0];
  if (!first) return 'A neighbor';
  // Names arrive from GoHighLevel however the customer or a staffer typed
  // them, and lowercase is common ("david"). This is the first word of a link
  // preview a stranger sees, so lift the first letter only — never lowercase
  // the rest, which would wreck McDonald, DeSantis, or an all-caps surname.
  // Live dev check 2026-08-28 rendered "david thinks you'd love this".
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// ─── Link preview (Open Graph) ──────────────────────────────────────────────
// This page's whole job is to be TEXTED by one neighbor to another, so the
// preview card is the first thing the friend sees, before they ever tap.
// Without it this route inherited the ROOT layout's metadata, which carries no
// image and describes the operator console ("quoting, customer portal, and
// dashboard") — the wrong pitch to a homeowner, and verified live on
// quote.yulelovelights.com/refer/<code> as the only meta tags served.
// Wrap-review 2026-08-28, customer lens HIGH.
//
// The card image is a real completed job, the same class of photo this page
// falls back to for its hero. Deliberately NOT the referrer's own house even
// when we have it: preview images are fetched and cached by messaging
// platforms, which would put a customer's home in a third-party cache. The
// page itself still shows their house.
//
// noindex: the URL embeds a personal referral code. It should be shareable by
// the person who owns it, never surfaced in search. Open Graph scrapers ignore
// robots directives, so the preview card still renders.
const SHARE_CARD = '/refer-share-card.jpg';

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { code } = await params;
  // A bad code must still return usable metadata: the page's own notFound()
  // owns that case, and a throw here would break the whole response.
  const referrer = await getReferralByCode(code).catch(() => null);
  const firstName = referrer ? firstNameOf(referrer.name) : null;

  const title = firstName
    ? `${firstName} thinks you'd love this`
    : 'A neighbor sent you this';
  const description =
    `${formatUsd(SPRITZER_VALUE_USD)} in free lighting on your first install with Yule Love Lights. ` +
    'Free quote, no obligation.';
  const base = appBaseUrl();
  const url = `${base}/refer/${encodeURIComponent(code)}`;
  const image = {
    url: `${base}${SHARE_CARD}`,
    width: 1200,
    height: 630,
    alt: 'A Long Island home lit by Yule Love Lights: warm-white roofline bulbs, lit wreaths, and light-wrapped trees along the driveway',
  };

  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: false, follow: false },
    openGraph: {
      type: 'website',
      siteName: 'Yule Love Lights',
      url,
      title,
      description,
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image.url],
    },
  };
}

// The referrer's most recently APPROVED quote (customer_approved_at set):
// the source for both the hero photo (their own house) and the fallback
// gallery's service type when they have no design photo to show. Loosened
// from "booked" (deposit paid) to "approved" (#41 adversarial-review MED fix,
// Naldo: show the hero as soon as the customer has approved their design.
// Don't make the referral ask wait on a deposit that may be weeks out).
async function latestApprovedQuote(customerId: string): Promise<{ id: string; serviceType: ServiceType | null } | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('quotes')
    .select('id, service_type')
    .eq('customer_id', customerId)
    .not('customer_approved_at', 'is', null)
    .order('customer_approved_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; service_type: string | null }>();
  if (error || !data) return null;
  return { id: data.id, serviceType: asServiceType(data.service_type) };
}

// Referral page bug batch 2026-07-17 (ledger #41) fix 1: the hero used to
// show the referrer's RAW base house photo (`design.photoUrl`, no lights;
// the lights only exist as scene data drawn over the photo). Owner-approved
// fix: render the live lit-design with the same renderer as the portal, via
// the ReferralHeroDesign client island. Per-quote image visibility deliberately
// does not change this public referral hero; customer quote payloads and the
// self-serve design poller enforce it separately. The 'design' branch below carries
// everything that island needs; the 'photo' branch is the unchanged
// gallery-photo fallback (no design, opted out, or no photo on the design).
// HeroResolution itself now lives in ./ReferHero (naldo/referral-link-
// preview, PIECE 2), the shared component this page and the no-database
// /refer/preview route both render.

async function resolveHero(
  latest: { id: string; serviceType: ServiceType | null } | null,
  photoOptout: boolean,
): Promise<HeroResolution> {
  // Fallback: a completed-work gallery photo matched to the referrer's latest
  // service type (undefined/unknown reads as holiday, galleryItemsFor's default).
  const gallery = galleryItemsFor(latest?.serviceType ?? undefined);
  const fallback = gallery[0];
  if (!photoOptout && latest) {
    try {
      const design = await getDesignByQuote(latest.id);
      if (design?.photoUrl) {
        // fallbackUrl lets ReferralHeroDesign swap to the gallery photo if
        // the live render ever fails at runtime (mirrors the previous
        // #41 adversarial-review LOW fix's onError swap, one layer up).
        return {
          kind: 'design',
          scene: design.scene,
          photoUrl: design.photoUrl,
          photoW: design.photoW,
          photoH: design.photoH,
          alt: 'A recent Yule Love Lights install, lit up',
          fallbackUrl: fallback.src,
        };
      }
    } catch (err) {
      console.error('[refer/:code] hero design photo lookup failed:', err);
    }
  }
  return { kind: 'photo', url: fallback.src, alt: fallback.alt };
}

// Team metadata: mirrors src/app/portal/[quoteId]/page.tsx resolveTeam()
// exactly (env-driven, MOCK_TEAM fallback). Duplicated rather than shared so
// this fix stays scoped to the refer route only (portal/[quoteId]/page.tsx is
// Jason's area: see AGENTS.md area ownership).
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

export default async function ReferPage({ params }: { params: Promise<Params> }) {
  const { code } = await params;
  const referrer = await getReferralByCode(code);
  if (!referrer) notFound();

  // Independent loads (mirrors the portal page's own parallel-fetch pattern,
  // audit W4-005). Reviews/settings don't depend on the referrer's latest
  // quote, and the quote lookup itself is shared by the hero AND the new
  // per-service-type sections below (fix 3), so it's resolved once here
  // instead of once per section.
  const [latest, appSettings, liveReviews] = await Promise.all([
    latestApprovedQuote(referrer.customerId),
    getAppSettings(),
    fetchGoogleReviews(),
  ]);
  const hero = await resolveHero(latest, referrer.photoOptout);
  const firstName = firstNameOf(referrer.name);
  const bookedThrough = process.env.NEXT_PUBLIC_PORTAL_BOOKED_THROUGH_DATE?.trim();
  const team = resolveTeam();
  // Fix 3 sections branch on the referrer's latest service type, same as the
  // portal (undefined/unknown reads as holiday: each component's own default).
  const referSvcType = latest?.serviceType ?? undefined;
  const faqItems =
    referSvcType === 'event'
      ? EVENT_FAQ
      : referSvcType === 'permanent'
        ? PERMANENT_FAQ
        : referSvcType === 'permanent_bistro'
          ? BISTRO_FAQ
          : MOCK_FAQ;

  return (
    <main className="relative min-h-screen w-full bg-[#060B0F]">
      <ReferralPageTracker code={code} />

      {/* ── Hero (extracted to ./ReferHero, naldo/referral-link-preview
          PIECE 2, so the no-database preview route can render the exact
          same component) ── */}
      <ReferHero hero={hero} firstName={firstName} palette={appSettings.colors} renderSettings={appSettings.render} />

      {/* ── Offer block ── */}
      <section aria-labelledby="refer-offer-heading" className="w-full">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14 md:py-16">
          <h2 id="refer-offer-heading" className="sr-only">
            The referral offer
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-6">
              <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#FFB744] mb-2">
                For you
              </p>
              <p className="font-display text-[24px] font-semibold text-[#F4ECD8]">
                {formatUsd(SPRITZER_VALUE_USD)} in free lighting
              </p>
              <p className="mt-2 text-[14px] text-[#A89F87] leading-[1.6]">
                {REFERRAL_FRIEND_SPRITZERS.count} staked spotlights for your yard ({REFERRAL_FRIEND_SPRITZERS.sizeInches}
                &quot; spritzers) on your first booked install. No purchase needed to get your free quote.
              </p>
            </div>
            <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-6">
              <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#FFB744] mb-2">
                For {firstName}
              </p>
              <p className="font-display text-[24px] font-semibold text-[#F4ECD8]">
                {formatUsd(REFERRAL_CREDIT_USD)} off any job
              </p>
              <p className="mt-2 text-[14px] text-[#A89F87] leading-[1.6]">
                Good toward any Yule Love Lights service: holiday, permanent, event and wedding
                lighting, or bistro. Their credit is applied once you book, and it stays good
                for {REFERRAL_CREDIT_EXPIRY_YEARS} years.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Form ── */}
      <section aria-labelledby="refer-form-heading" className="w-full">
        <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 pb-14 md:pb-16">
          <h2
            id="refer-form-heading"
            className="font-display text-[24px] md:text-[30px] font-semibold text-[#F4ECD8] text-center mb-6"
          >
            Tell us where to look.
          </h2>
          <ReferralForm
            code={code}
            friendSpritzers={{ ...REFERRAL_FRIEND_SPRITZERS, valueUsd: SPRITZER_VALUE_USD }}
          />
        </div>
      </section>

      {/* ── Contact info: directly under the form (owner call 2026-07-18):
          a visitor who won't fill the form gets the phone number before the
          long scroll starts. ── */}
      <PersonalContact leaderName={team.leaderName} photo={team.photo} phone={team.phone} />

      {/* ── Trust ── */}
      <TrustSection />

      {/* Referral page bug batch 2026-07-17 (ledger #41) fix 3: the sections
          below the form were missing entirely. This page stopped at Trust.
          Owner-approved order: reviews, install photos, steps, protection,
          FAQ, about us (contact info moved above Trust, owner call
          2026-07-18). Every prop below is sourced exactly
          like src/app/portal/[quoteId]/page.tsx (same components, same
          fallbacks); no quote-specific customer data is read anywhere here:
          only generic/curated content plus the referrer's own hero above. */}

      {/* ── Google Reviews: live when configured, mock block otherwise
          (all-or-nothing, same as the portal: never live rating + mock
          quotes together). ── */}
      <GoogleReviews
        rating={liveReviews?.rating ?? 4.9}
        totalReviews={liveReviews?.totalReviews ?? 187}
        reviews={liveReviews?.reviews ?? MOCK_REVIEWS}
        reviewsUrl={liveReviews?.reviewsUrl ?? GMB_REVIEWS_URL}
      />

      {/* ── Install photos: the curated completed-work gallery (never the
          customer's own PhotoGallery/design; that needs SelectionContext,
          which this page doesn't have). ── */}
      <Gallery items={galleryItemsFor(referSvcType)} crossSell={crossSellFor(referSvcType)} />

      {/* ── Steps ── */}
      <WhatHappensNext serviceType={referSvcType} />

      {/* ── Protection: the standard variant only; a referral visitor has
          no approval to show the permanent-snapshot variant against. ── */}
      <RiskReversal serviceType={referSvcType} />

      {/* ── FAQ ── */}
      <FAQ items={faqItems} />

      {/* ── About us ── */}
      <MeetYourTeam photo={team.photo} paragraphs={team.companyBio} badges={team.badges} />

      {/* ── Urgency line (rating moved above the fold, see hero) ── */}
      {bookedThrough && (
        <section className="w-full bg-[#0D1519] border-t border-[#1F2A23]">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16 text-center">
            <p className="text-[13px] text-[#A89F87]">
              Currently booking installs through {bookedThrough}.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
