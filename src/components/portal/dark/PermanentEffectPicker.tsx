'use client';

// Portal — PERMANENT effect picker (#88 P6b-4). The permanent analog of the color
// row: pick HOW the lights move (Solid / Chase / Fade), separately from the color,
// so any color can play any effect. Drives the hero's live animation via
// SelectionContext.permanentEffect and freezes into the approval snapshot. Rendered
// under the color picker for permanent quotes only. A single color has nothing to
// move, so on a solid color every effect looks the same (still) — that's expected.

import { useSelection } from '../SelectionContext';
import { PERMANENT_EFFECTS, type SceneEffect } from '@/lib/design/permanentScenes';
import { track } from '@/lib/analytics/posthog';
import type { ServiceType } from '@/lib/serviceType';

// PostHog Wave 2 — property builder for effect_changed, extracted as a pure
// function (no jsdom component-test infra in this repo) so the event-name/
// property-shape contract is covered without rendering the component.
export function effectChangedProps(quoteId: string | undefined, serviceType: ServiceType | undefined, effect: SceneEffect) {
  return { quote_id: quoteId, service_type: serviceType, effect };
}

export function PermanentEffectPicker() {
  const { permanentEffect, setPermanentEffect, locked, quoteId, serviceType } = useSelection();

  return (
    <section
      aria-labelledby="portal-permanent-effect-heading"
      className="w-full bg-[#0D1519] border-b border-[#1F2A23]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-7">
        <p
          id="portal-permanent-effect-heading"
          className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-1.5"
        >
          Effect
        </p>
        <p className="text-[14px] md:text-[15px] text-[#A89F87] mb-4">
          How your lights move. A multi-color look chases or fades; a single color stays solid.
        </p>
        <div
          role="radiogroup"
          aria-label="Choose a lighting effect"
          aria-disabled={locked || undefined}
          className={`flex flex-wrap gap-2.5 md:gap-3 ${locked ? 'opacity-60 pointer-events-none' : ''}`}
        >
          {PERMANENT_EFFECTS.map((e) => {
            const active = permanentEffect === e.effect;
            return (
              <button
                key={e.effect}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setPermanentEffect(e.effect);
                  track('effect_changed', effectChangedProps(quoteId, serviceType, e.effect));
                }}
                // min-h-[44px] meets the 44px iOS/WCAG tap-target minimum.
                className={`inline-flex items-center gap-1.5 rounded-full border min-h-[44px] px-4 py-2 text-[13px] md:text-[14px] font-medium cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519] ${
                  active
                    ? 'border-[#E8B862] bg-[#E8B862]/15 text-[#F4ECD8]'
                    : 'border-[#3C4F43] text-[#A89F87] hover:border-[#E8B862]/60 hover:text-[#F4ECD8]'
                }`}
              >
                {e.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
