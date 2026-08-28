// Referral landing page hero (ledger #41), extracted out of page.tsx
// (naldo/referral-link-preview, PIECE 2) so it can be rendered a second
// place: the no-database preview route at src/app/refer/preview/page.tsx.
// That route exists so /referral-link can show someone a sample of what
// their friend receives before they generate a real link (PIECE 3), and it
// has to be visibly the SAME page, not a hand-copied lookalike that quietly
// drifts from this one over time. Sharing this component is what makes that
// true by construction.
//
// This file only ever renders from data its caller already resolved (a
// HeroResolution + a first name); it makes no GoHighLevel call, no Supabase
// call, and imports nothing that does. That is deliberate: the preview
// route depends on that being true to stay clear of real customer data (see
// its own file header).

import type { DesignScene } from '@/lib/designs';
import type { Scene, BulbColor } from '@/lib/design/sceneTypes';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';
import { CompactTrustRow } from '@/components/portal/dark/CompactTrustRow';
import { ReferralHeroImage } from './ReferralHeroImage';
import { ReferralHeroDesign } from './ReferralHeroDesign';
import { ReferralHeroBadge } from './ReferralHeroBadge';

// `scene` is typed as DesignScene (a Scene alias, see designs.ts) here since
// that is what a caller resolving a real referrer's design already has on
// hand; ReferralHeroDesign itself wants the Scene name, and the two are the
// same type.
export type HeroResolution =
  | {
      kind: 'design';
      scene: DesignScene;
      photoUrl: string;
      photoW: number | null;
      photoH: number | null;
      alt: string;
      fallbackUrl: string;
    }
  | { kind: 'photo'; url: string; alt: string };

export function ReferHero({
  hero,
  firstName,
  palette,
  renderSettings,
}: {
  hero: HeroResolution;
  firstName: string;
  /** Only ever read on the 'design' branch. The preview route never resolves
   *  a design, so it never has to supply these. */
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
}) {
  return (
    <section className="relative w-full">
      <div className="relative w-full h-[56vh] min-h-[340px] md:h-[62vh] overflow-hidden">
        {hero.kind === 'design' ? (
          <ReferralHeroDesign
            scene={hero.scene as Scene}
            photoUrl={hero.photoUrl}
            photoW={hero.photoW}
            photoH={hero.photoH}
            palette={palette}
            renderSettings={renderSettings}
            alt={hero.alt}
            fallbackSrc={hero.fallbackUrl}
          />
        ) : (
          <ReferralHeroImage src={hero.url} alt={hero.alt} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#060B0F] via-[#060B0F]/60 to-[#060B0F]/10" />
        {/* Non-customers are the common case for this page (naldo/
            referral-self-serve): most recipients have no approved design of
            their own, so the fallback gallery photo is someone ELSE's
            house. Label it so the hero never reads as if it were the
            referrer's own home. Photo branch only (the component itself
            gates on hero.kind). Top-left, not bottom-left, since the
            headline block below is pulled up over the bottom of the hero
            with a negative margin and can collide with a bottom badge at
            narrow widths. */}
        <ReferralHeroBadge kind={hero.kind} />
      </div>
      <div className="relative -mt-24 md:-mt-32 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-4">
          You were personally invited
        </p>
        <h1 className="font-display text-[34px] leading-[1.1] md:text-[54px] md:leading-[1.05] font-semibold text-[#F4ECD8] tracking-[-0.02em]">
          {hero.kind === 'design'
            ? `${firstName} thinks your house deserves this too.`
            : `${firstName} thinks your house could look like this.`}
        </h1>
        <p className="mt-5 text-[17px] md:text-[19px] text-[#E0D7C1] leading-[1.6]">
          Give us your address. We will follow up with a free quote, no visit needed.
        </p>

        {/* Compact trust signal, above the fold and above the lead form
            (PS-A3 fix): a first-time visitor sees proof before we ask for
            contact info. */}
        <div className="mt-6">
          <CompactTrustRow />
        </div>
      </div>
    </section>
  );
}
