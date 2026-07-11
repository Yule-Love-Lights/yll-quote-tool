// Referral landing page (ledger #41). Public — no operator auth, gated only by
// the referral code in the URL (allowlisted in src/lib/auth/operatorGate.ts).
// Personal-link attribution half of the referral program; the "mention"
// half is a picker in the quote builder (src/components/quote/QuoteBuilder.tsx).
//
// Server component: resolves the code -> referrer, the hero photo (the
// referrer's own latest booked install, honoring their photo opt-out, else a
// completed-work gallery photo for their service type), then hands static
// props to two small client islands (the view-tracker + the lead form).

import { notFound } from 'next/navigation';
import { Star } from 'lucide-react';
import { getReferralByCode, REFERRAL_CREDIT_USD, REFERRAL_FRIEND_SPRITZERS } from '@/lib/referrals';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { getDesignByQuote } from '@/lib/designs';
import { galleryItemsFor } from '@/components/portal/mockQuote';
import { TrustSection } from '@/components/portal/dark/TrustSection';
import { formatUsd } from '@/components/portal/format';
import { asServiceType, type ServiceType } from '@/lib/serviceType';
import { ReferralPageTracker } from './ReferralPageTracker';
import { ReferralForm } from './ReferralForm';

type Params = { code: string };

function firstNameOf(name: string | null): string {
  if (!name) return 'A neighbor';
  const first = name.trim().split(/\s+/)[0];
  return first || 'A neighbor';
}

// The referrer's most recently BOOKED quote (deposit paid) — the source for
// both the hero photo (their own house) and the fallback gallery's service
// type when they have no design photo to show.
async function latestBookedQuote(customerId: string): Promise<{ id: string; serviceType: ServiceType | null } | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('quotes')
    .select('id, service_type')
    .eq('customer_id', customerId)
    .not('deposit_paid_at', 'is', null)
    .order('deposit_paid_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; service_type: string | null }>();
  if (error || !data) return null;
  return { id: data.id, serviceType: asServiceType(data.service_type) };
}

async function resolveHero(
  customerId: string,
  photoOptout: boolean,
): Promise<{ url: string; alt: string }> {
  const latest = await latestBookedQuote(customerId);
  if (!photoOptout && latest) {
    try {
      const design = await getDesignByQuote(latest.id);
      if (design?.photoUrl) {
        return { url: design.photoUrl, alt: 'A recent Yule Love Lights install' };
      }
    } catch (err) {
      console.error('[refer/:code] hero design photo lookup failed:', err);
    }
  }
  // Fallback: a completed-work gallery photo matched to the referrer's latest
  // service type (undefined/unknown reads as holiday, galleryItemsFor's default).
  const gallery = galleryItemsFor(latest?.serviceType ?? undefined);
  const fallback = gallery[0];
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
      <ReferralPageTracker referrerCustomerId={referrer.customerId} code={code} />

      {/* ── Hero ── */}
      <section className="relative w-full">
        <div className="relative w-full h-[56vh] min-h-[340px] md:h-[62vh] overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={hero.url} alt={hero.alt} className="absolute inset-0 w-full h-full object-cover" />
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
          <ReferralForm code={code} referrerCustomerId={referrer.customerId} />
        </div>
      </section>

      {/* ── Trust ── */}
      <TrustSection />

      {/* ── Static reviews line + urgency ── */}
      <section className="w-full bg-[#0D1519] border-t border-[#1F2A23]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16 text-center">
          <div className="inline-flex items-center gap-2 text-[15px] text-[#E0D7C1]">
            <Star className="w-4 h-4 fill-[#E8B862] text-[#E8B862]" aria-hidden />
            <span className="font-semibold">5.0</span>
            <span className="text-[#A89F87]">&middot; 166 Google reviews</span>
          </div>
          {bookedThrough && (
            <p className="mt-4 text-[13px] text-[#A89F87]">
              Currently booking installs through {bookedThrough}.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
