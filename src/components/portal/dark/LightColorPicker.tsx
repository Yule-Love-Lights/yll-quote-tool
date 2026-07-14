'use client';

// Portal — Light color/pattern picker (#10), as a standalone band BETWEEN the
// hero (packages) and "What's Included" (#48 / #57 mobile pass). It used to live
// in the hero's bottom overlay, where on a phone the swatches floated up over
// the photo and got in the way. Here it's its own dark band with larger tap
// targets. Recolors the live design in real time via SelectionContext; the
// portal page renders this only when a design is linked.

import { Sun } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import {
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  MAX_CUSTOM_PATTERN,
} from '@/lib/design/colorSchemes';
import { colorOf } from '@/components/design/editor-core/colors';
import { track } from '@/lib/analytics/posthog';
import type { ServiceType } from '@/lib/serviceType';

// Customer-facing color label (cool-white is shown as the product name "Pure White").
function colorLabel(id: string): string {
  return id === 'cool-white' ? 'Pure White' : colorOf(id).label;
}

// Build a CSS swatch background from a scheme's color ids. null/empty ("as
// designed") → a neutral two-tone chip that reads as "no override". Single color
// → solid; multi → even-segment diagonal gradient so the pattern is visible.
function schemeSwatch(colorIds: string[] | null): React.CSSProperties {
  if (!colorIds || colorIds.length === 0) {
    return { background: 'linear-gradient(135deg, #c9c2b0 0 50%, #6f6a5c 50% 100%)' };
  }
  const hexes = colorIds.map((id) => colorOf(id).hex);
  if (hexes.length === 1) return { background: hexes[0] };
  const stops = hexes
    .map((h, i) => `${h} ${(i / hexes.length) * 100}% ${((i + 1) / hexes.length) * 100}%`)
    .join(', ');
  return { background: `linear-gradient(135deg, ${stops})` };
}

// PostHog Wave 2 — analytics property builders for the light-color band.
// Extracted as pure functions (no jsdom component-test infra in this repo —
// see SelectionContext.test.ts) so the event-name/property-shape contract is
// covered without rendering the component. Colors are always catalog scheme/
// color ids here, never a hex value or free-text label.
export function daylightToggledProps(quoteId: string | undefined, serviceType: ServiceType | undefined, nextOn: boolean) {
  return { quote_id: quoteId, service_type: serviceType, on: nextOn };
}

export function schemeChangedProps(quoteId: string | undefined, serviceType: ServiceType | undefined, schemeId: string) {
  return { quote_id: quoteId, service_type: serviceType, scheme: schemeId, custom: false };
}

export function customColorsOpenedProps(quoteId: string | undefined, serviceType: ServiceType | undefined) {
  return { quote_id: quoteId, service_type: serviceType };
}

export function customColorAddedProps(quoteId: string | undefined, serviceType: ServiceType | undefined, colorId: string) {
  return { quote_id: quoteId, service_type: serviceType, scheme: 'custom', custom: true, color: colorId };
}

export function LightColorPicker() {
  const {
    colorSchemeId,
    setColorScheme,
    customPattern,
    setCustomPattern,
    schemes,
    buildableColorIds,
    locked,
    showDaylight,
    toggleDaylight,
    daylightAvailable,
    quoteId,
    serviceType,
  } = useSelection();

  const customActive = colorSchemeId === CUSTOM_SCHEME_ID;
  const atMax = customPattern.length >= MAX_CUSTOM_PATTERN;
  const addColor = (id: string) => {
    if (locked || customPattern.length >= MAX_CUSTOM_PATTERN) return;
    setColorScheme(CUSTOM_SCHEME_ID);
    setCustomPattern([...customPattern, id]);
    track('color_changed', customColorAddedProps(quoteId, serviceType, id));
  };
  // Removing the last color (or Clear) exits custom mode back to "As designed" so
  // the highlighted radio matches what's on screen — an empty custom pattern
  // renders identically to as-designed, so leaving 'custom' selected would show a
  // gold-highlighted chip over an unchanged picture.
  const clearCustom = () => {
    if (locked) return;
    setCustomPattern([]);
    setColorScheme(DEFAULT_COLOR_SCHEME_ID);
  };
  const removeAt = (i: number) => {
    if (locked) return;
    const next = customPattern.filter((_, idx) => idx !== i);
    setCustomPattern(next);
    if (next.length === 0) setColorScheme(DEFAULT_COLOR_SCHEME_ID);
  };

  return (
    <section
      id="light-color"
      tabIndex={-1}
      aria-labelledby="portal-color-heading"
      // scroll-mt gives a little breathing room when the "Click here to change
      // colors" link (DesignReprise) scrolls this band into view; tabIndex + the
      // suppressed focus outline let that link move keyboard/SR focus here.
      className="w-full bg-[#0D1519] border-y border-[#1F2A23] scroll-mt-6 focus:outline-none"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-10">
        <p
          id="portal-color-heading"
          className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-1.5"
        >
          Light color
        </p>
        <p className="text-[14px] md:text-[15px] text-[#A89F87] mb-4">
          Pick a color or pattern — your design recolors instantly above.
        </p>
        {/* #61 — daytime⇄lit view toggle, moved here from the hero top bar. Drives
            the hero's day/night view via SelectionContext. Only when a base photo
            exists to switch to. */}
        {daylightAvailable && (
          <button
            type="button"
            onClick={() => {
              toggleDaylight();
              track('daylight_toggled', daylightToggledProps(quoteId, serviceType, !showDaylight));
            }}
            aria-pressed={showDaylight}
            // min-h-[44px] meets the 44px iOS/WCAG tap-target minimum (audit fix #98).
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
                onClick={() => {
                  setColorScheme(s.id);
                  track('color_changed', schemeChangedProps(quoteId, serviceType, s.id));
                }}
                // min-h-[44px] meets the 44px iOS/WCAG tap-target minimum (audit fix #98).
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
          {/* Build your own (#49) — reveals the tap-to-build palette below. */}
          <button
            type="button"
            role="radio"
            aria-checked={customActive}
            onClick={() => {
              setColorScheme(CUSTOM_SCHEME_ID);
              track('custom_colors_opened', customColorsOpenedProps(quoteId, serviceType));
            }}
            // min-h-[44px] meets the 44px iOS/WCAG tap-target minimum (audit fix #98).
            className={`inline-flex items-center gap-1.5 rounded-full border min-h-[44px] px-3 py-2 text-[12px] md:text-[13px] font-medium cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519] ${
              customActive
                ? 'border-[#E8B862] bg-[#E8B862]/15 text-[#F4ECD8]'
                : 'border-[#3C4F43] text-[#A89F87] hover:border-[#E8B862]/60 hover:text-[#F4ECD8]'
            }`}
          >
            <span
              aria-hidden
              className="w-3.5 h-3.5 rounded-full ring-1 ring-white/40 shrink-0"
              style={{
                background:
                  'conic-gradient(from 0deg, #ff2a2a, #ffe61f, #1aff6f, #3a7bff, #a042ff, #ff2a2a)',
              }}
            />
            Build your own
          </button>
        </div>

        {/* Custom pattern builder (#49) — tap palette colors to build an ordered
            sequence the bulbs cycle through; the design recolors live as you go. */}
        {customActive && (
          <div className={`mt-4 ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
            <p className="text-[12px] md:text-[13px] text-[#A89F87] mb-2">
              {customPattern.length > 0
                ? 'Your pattern — the lights repeat this sequence. Tap a color to remove it.'
                : 'Tap colors below to build your pattern — the lights cycle through them in order.'}
            </p>
            {customPattern.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-3">
                {customPattern.map((id, i) => (
                  <button
                    key={`${id}-${i}`}
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label={`Position ${i + 1}: ${colorLabel(id)} — tap to remove`}
                    // a11y fix (W4-021): min-w/h-[44px] gives the button a
                    // comfortable tap area; the visible chip stays 28px (w-7 h-7)
                    // centered inside via flex, so the small-dot look is unchanged.
                    className="group relative inline-flex items-center justify-center min-w-[44px] min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] rounded-full"
                  >
                    <span
                      aria-hidden
                      className="w-7 h-7 rounded-full ring-1 ring-white/40 group-hover:ring-white/80 transition-shadow"
                      style={{ background: colorOf(id).hex }}
                    />
                    {/* × delete cue — visible on hover (desktop) and always shown
                        on touch devices, which have no hover state. */}
                    <span
                      aria-hidden
                      className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-[#0D1519] text-[#F4ECD8] text-[9px] leading-[14px] text-center opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
                    >
                      ×
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearCustom}
                  className="text-[12px] text-[#A89F87] hover:text-[#F4ECD8] underline ml-1 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            )}
            <p className="text-[11px] font-semibold tracking-[0.12em] uppercase text-[#7E8B80] mb-1.5">
              Add a color
            </p>
            <div className="flex flex-wrap gap-2" aria-label="Add a color to your pattern">
              {buildableColorIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => addColor(id)}
                  disabled={atMax}
                  aria-label={`Add ${colorLabel(id)}`}
                  title={colorLabel(id)}
                  // a11y fix (W4-021): min-w/h-[44px] gives the button a
                  // comfortable tap area; the visible swatch stays 32px (w-8 h-8)
                  // centered inside via flex, so the small-dot look is unchanged.
                  className="group inline-flex items-center justify-center min-w-[44px] min-h-[44px] cursor-pointer disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] rounded-full"
                >
                  <span
                    aria-hidden
                    className="w-8 h-8 rounded-full ring-1 ring-white/40 transition-transform group-hover:scale-110 group-disabled:opacity-40"
                    style={{ background: colorOf(id).hex }}
                  />
                </button>
              ))}
            </div>
            {atMax && (
              <p role="status" aria-live="polite" className="text-[11px] text-[#A89F87] mt-2">
                That&apos;s the max ({MAX_CUSTOM_PATTERN} colors) — remove one to add another.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
