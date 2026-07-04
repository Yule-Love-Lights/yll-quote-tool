'use client';

// Portal — PERMANENT light-color toggle (#88 P6b-2). The permanent analog of the
// holiday LightColorPicker: a slim dark band below the packages that lets the
// customer preview WARM WHITE (nightly curb appeal) vs a few color scenes — the
// "warm white every night, any color for the seasons" story. It reuses the SAME
// SelectionContext colorSchemeId machinery as the holiday picker (so the choice
// freezes into the approval snapshot through the existing StickyBottomBar path),
// but renders the fixed permanent scheme set the portal page passes to the
// provider (PERMANENT_COLOR_SCHEMES) — NO build-your-own, no seasonal patterns.
// Rendered only when a design is linked (recolor needs a live scene).

import { Sun } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { colorOf } from '@/components/design/editor-core/colors';

// Build a CSS swatch background from a scheme's color ids (mirrors the holiday
// picker's helper). null/empty ("as designed" = the full designed color) → a
// vivid multi-hue chip that reads as "your color". Single color → solid; multi →
// even-segment diagonal gradient so the pattern is visible.
function schemeSwatch(colorIds: string[] | null): React.CSSProperties {
  if (!colorIds || colorIds.length === 0) {
    return {
      background:
        'conic-gradient(from 0deg, #ff2a2a, #ffe61f, #1aff6f, #3a7bff, #a042ff, #ff2a2a)',
    };
  }
  const hexes = colorIds.map((id) => colorOf(id).hex);
  if (hexes.length === 1) return { background: hexes[0] };
  const stops = hexes
    .map((h, i) => `${h} ${(i / hexes.length) * 100}% ${((i + 1) / hexes.length) * 100}%`)
    .join(', ');
  return { background: `linear-gradient(135deg, ${stops})` };
}

export function PermanentColorToggle() {
  const {
    colorSchemeId,
    setColorScheme,
    schemes,
    locked,
    showDaylight,
    toggleDaylight,
    daylightAvailable,
  } = useSelection();

  return (
    <section
      id="light-color"
      tabIndex={-1}
      aria-labelledby="portal-permanent-color-heading"
      // scroll-mt + tabIndex mirror the holiday picker so a "change your color"
      // reprise link can scroll/focus this band.
      className="w-full bg-[#0D1519] border-y border-[#1F2A23] scroll-mt-6 focus:outline-none"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-10">
        <p
          id="portal-permanent-color-heading"
          className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-1.5"
        >
          Your color, year-round
        </p>
        <p className="text-[14px] md:text-[15px] text-[#A89F87] mb-4">
          Warm white every night for curb appeal, any color for the seasons — all from your
          phone. Preview a look; your design updates above.
        </p>
        {/* #61 — daytime⇄lit view toggle, same as the holiday band. Only when a
            base photo exists to switch to. */}
        {daylightAvailable && (
          <button
            type="button"
            onClick={toggleDaylight}
            aria-pressed={showDaylight}
            className="inline-flex items-center gap-1.5 min-h-[44px] py-2 mb-3 text-[13px] md:text-[14px] font-semibold text-[#E8B862] hover:text-[#F5CC7A] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519] rounded-sm"
          >
            <Sun className="w-4 h-4" aria-hidden />
            {showDaylight ? 'See the lights' : 'See it in daylight'}
          </button>
        )}
        <div
          role="radiogroup"
          aria-label="Choose your light color"
          aria-disabled={locked || undefined}
          className={`flex flex-wrap gap-2.5 md:gap-3 ${locked ? 'opacity-60 pointer-events-none' : ''}`}
        >
          {schemes.map((s) => {
            const active = colorSchemeId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setColorScheme(s.id)}
                // min-h-[44px] meets the 44px iOS/WCAG tap-target minimum.
                className={`inline-flex items-center gap-1.5 rounded-full border min-h-[44px] px-3 py-2 text-[12px] md:text-[13px] font-medium cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519] ${
                  active
                    ? 'border-[#E8B862] bg-[#E8B862]/15 text-[#F4ECD8]'
                    : 'border-[#3C4F43] text-[#A89F87] hover:border-[#E8B862]/60 hover:text-[#F4ECD8]'
                }`}
              >
                <span
                  aria-hidden
                  className="w-3.5 h-3.5 rounded-full ring-1 ring-white/40 shrink-0"
                  style={schemeSwatch(s.colorIds)}
                />
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
