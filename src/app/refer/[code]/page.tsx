// Referral landing page (ledger #41). Public — no operator auth, gated only by
// the referral code in the URL (allowlisted in src/lib/auth/operatorGate.ts).
// Personal-link attribution half of the referral program; the "mention"
// half is a picker in the quote builder (src/components/quote/QuoteBuilder.tsx).
//
// Server component: resolves the code -> referrer, the hero photo (the
// referrer's own latest APPROVED install, honoring their photo opt-out, else
// a completed-work gallery photo for their service type), then hands static
// props to small client islands (the view-tracker, the lead form, the hero
// image's onError fallback).

import { notFound } from 'next/navigation';
import { Star, ShieldCheck, Wrench } from 'lucide-react';
import { getReferralByCode, REFERRAL_CREDIT_USD, REFERRAL_FRIEND_SPRITZERS } from '@/lib/referrals';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { getDesignByQuote } from '@/lib/designs';
import { galleryItemsFor } from '@/components/portal/mockQuote';
import { TrustSection } from '@/components/portal/dark/TrustSection';
import { formatUsd } from '@/components/portal/format';
import { asServiceType, type ServiceType } from '@/lib/serviceType';
import { ReferralPageTracker } from './ReferralPageTracker';
import { ReferralForm } from './ReferralForm';
import { ReferralHeroImage } from './ReferralHeroImage';

// #41 adversarial-review LOW fix: this page is personalized per referral code
// (a different customer's hero photo + gallery fallback each time) — force
// dynamic rendering so it's never statically cached/served cross-referrer.
export const dynamic = 'force-dynamic';

type Params = { code: string };

function firstNameOf(name: string | null): string {
  if (!name) return 'A neighbor';
  const first = name.trim().split(/\s+/)[0];
  return first || 'A neighbor';
}

// The referrer's most recently APPROVED quote (customer_approved_at set) —
// the source for both the hero photo (their own house) and the fallback
// gallery's service type when they have no design photo to show. Loosened
// from "booked" (deposit paid) to "approved" (#41 adversarial-review MED fix,
// Naldo: show the hero as soon as the customer has approved their design —
// don't make the referral ask wait on a deposit that may be weeks out).
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

async function resolveHero(
  customerId: string,
  photoOptout: boolean,
): Promise<{ url: string; alt: string; fallbackUrl?: string }> {
  const latest = await latestApprovedQuote(customerId);
  // Fallback: a completed-work gallery photo matched to the referrer's latest
  // service type (undefined/unknown reads as holiday, galleryItemsFor's default).
  const gallery = galleryItemsFor(latest?.serviceType ?? undefined);
  const fallback = gallery[0];
  if (!photoOptout && latest) {
    try {
      const design = await getDesignByQuote(latest.id);
      if (design?.photoUrl) {
        // #41 adversarial-review LOW fix: fallbackUrl lets the client-side
        // hero swap to the gallery photo if this private-bucket URL 404s.
        return { url: design.photoUrl, alt: 'A recent Yule Love Lights install', fallbackUrl: fallback.src };
      }
    } catch (err) {
      console.error('[refer/:code] hero design photo lookup failed:', err);
    }
  }
  return { url: fallback.src, alt: fallback.alt };
}

export default async function ReferPage({ params }: { params: Promise<Params> }) {
  const { code } = await params;
  const referrer = await getReferralByCode(code);
  if (!referrer) notFound();

  const hero = await resolveHero(referrer.customerId, referrer.photoOptout);
  const firstName = firstNameOf(referrer.name);
  const bookedThrough = process.env.NEXT_PUBLIC_PORTAL_BOOKED_THROUGH_DATE?.trim();

  return (
    <main className="relative min-h-screen w-full bg-[#060B0F]">
      <ReferralPageTracker code={code} />

      {/* ── Hero ── */}
      <section className="relative w-full">
        <div className="relative w-full h-[56vh] min-h-[340px] md:h-[62vh] overflow-hidden">
          <ReferralHeroImage src={hero.url} alt={hero.alt} fallbackSrc={hero.fallbackUrl} />
          <div className="absolute inset-0 bg-gradient-to-t from-[#060B0F] via-[#060B0F]/60 to-[#060B0F]/10" />
        </div>
        <div className="relative -mt-24 md:-mt-32 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-4">
            You were personally invited
          </p>
          <h1 className="font-display text-[34px] leading-[1.1] md:text-[54px] md:leading-[1.05] font-semibold text-[#F4ECD8] tracking-[-0.02em]">
            {firstName} thinks your house deserves this.
          </h1>
          <p className="mt-5 text-[17px] md:text-[19px] text-[#E0D7C1] leading-[1.6]">
            See your own house in lights, free, no visit needed.
          </p>

          {/* Compact trust signal, above the fold and above the lead form
              (PS-A3 fix): a first-time visitor sees proof before we ask for
              contact info. */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <div className="inline-flex items-center gap-2 text-[14px] text-[#E0D7C1]">
              <Star className="w-4 h-4 fill-[#E8B862] text-[#E8B862]" aria-hidden />
              <span className="font-semibold">5.0</span>
              <span className="text-[#A89F87]">&middot; 166 Google reviews</span>
            </div>
            <div className="inline-flex items-center gap-1.5 text-[13px] text-[#A89F87]">
              <ShieldCheck className="w-4 h-4 text-[#E8B862]" aria-hidden />
              <span>Licensed &amp; insured</span>
            </div>
            <div className="inline-flex items-center gap-1.5 text-[13px] text-[#A89F87]">
              <Wrench className="w-4 h-4 text-[#E8B862]" aria-hidden />
              <span>48-hour fix guarantee</span>
            </div>
          </div>
        </div>
      </section>

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
                {REFERRAL_FRIEND_SPRITZERS.count} free {REFERRAL_FRIEND_SPRITZERS.sizeInches}&quot; spritzers
              </p>
              <p className="mt-2 text-[14px] text-[#A89F87] leading-[1.6]">
                On your first booked install. No purchase needed to get your free light preview.
              </p>
            </div>
            <div className="rounded-2xl bg-[#0D1519] border border-[#1F2A23] p-6">
              <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#FFB744] mb-2">
                For {firstName}
              </p>
              <p className="font-display text-[24px] font-semibold text-[#F4ECD8]">
                {formatUsd(REFERRAL_CREDIT_USD)} off next season
              </p>
              <p className="mt-2 text-[14px] text-[#A89F87] leading-[1.6]">
                Once you book your install, they get their credit automatically.
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
          <ReferralForm code={code} friendSpritzers={REFERRAL_FRIEND_SPRITZERS} />
        </div>
      </section>

      {/* ── Trust ── */}
      <TrustSection />

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
