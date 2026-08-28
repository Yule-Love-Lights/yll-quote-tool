// No-database preview of the referral landing page hero (naldo/referral-
// link-preview, PIECE 2). Exists so /referral-link can show someone a
// sample of what their friend receives before they generate a real link
// (see src/app/referral-link/PhoneFrame.tsx), with nobody's real name or
// house on it.
//
// This is a STATIC SIBLING of the dynamic [code] route, not a special value
// handled inside it. Next.js resolves a literal path segment ('preview')
// ahead of a dynamic one ([code]) at the same level, so a request for
// /refer/preview always lands here and never reaches [code]/page.tsx or the
// referral-code database lookup that page performs, regardless of anything
// in the URL.
//
// CRITICAL, by construction: this file imports NOTHING that touches
// Supabase or GoHighLevel. It takes no params, no searchParams, and reads
// no cookies or headers, so there is no user-supplied value anywhere in
// this module for a future edit to accidentally wire into a query. The
// hero it shows is exactly the gallery-fallback branch a real referrer
// with no approved design (or a photo opt-out) already gets, under a
// neutral placeholder first name, so it is never a stand-in for anyone's
// actual photo or link. See src/app/refer/[code]/ReferHero.tsx for the
// component itself; rendering it here (never a hand-copied duplicate) is
// what keeps this preview visibly the SAME page as the real one.
//
// Kept to the hero alone (no offer cards, form, gallery, reviews, FAQ, or
// team section): this is displayed small, inside a phone-shaped frame, on
// /referral-link, and the hero is the part that sells the idea. The rest of
// the real page is one tap away once a friend actually opens a real link.
//
// No `dynamic` export: unlike [code]/page.tsx (personalized per referral
// code, so it must never be cached across referrers), this page has
// nothing request-specific to read, so Next's default static rendering is
// exactly right, one build, served the same to everyone.

import type { Metadata } from 'next';
import { galleryItemsFor } from '@/components/portal/mockQuote';
import { ReferHero, type HeroResolution } from '../[code]/ReferHero';

// Kept out of search on purpose (this is a decorative sample, not a real
// referral page): explicit robots noindex/nofollow, same pattern as
// src/app/referral-link/page.tsx.
export const metadata: Metadata = {
  title: 'Sample Referral Link | Yule Love Lights',
  description: 'A sample of the page a referred friend sees.',
  robots: { index: false, follow: false },
};

// A generic placeholder, never a real referrer's name. galleryItemsFor(
// undefined) is the same holiday-default fallback gallery a real referrer
// with no approved design (or a photo opt-out) already gets on the real
// page, so this preview shows a real completed-work photo, just not tied
// to any one customer.
const PLACEHOLDER_FIRST_NAME = 'Sam';

export default function ReferPreviewPage() {
  const fallback = galleryItemsFor(undefined)[0];
  const hero: HeroResolution = { kind: 'photo', url: fallback.src, alt: fallback.alt };
  return (
    <main className="relative min-h-screen w-full bg-[#060B0F]">
      <ReferHero hero={hero} firstName={PLACEHOLDER_FIRST_NAME} />
    </main>
  );
}
