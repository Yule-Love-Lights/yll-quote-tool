'use client';

// Portal — Light color/pattern picker (#10), as a standalone band BETWEEN the
// hero (packages) and "What's Included" (#48 / #57 mobile pass). It used to live
// in the hero's bottom overlay, where on a phone the swatches floated up over
// the photo and got in the way. Here it's its own dark band with larger tap
// targets. Recolors the live design in real time via SelectionContext; the
// portal page renders this only when a design is linked.

import { useSelection } from '../SelectionContext';
import { COLOR_SCHEMES } from '@/lib/design/colorSchemes';
import { colorOf } from '@/components/design/editor-core/colors';

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

export function LightColorPicker() {
  const { colorSchemeId, setColorScheme, locked } = useSelection();
  return (
    <section
      aria-labelledby="portal-color-heading"
      className="w-full bg-[#0D1519] border-y border-[#1F2A23]"
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
        <div
          role="radiogroup"
          aria-label="Choose your light color"
          aria-disabled={locked || undefined}
          className={`flex flex-wrap gap-2 md:gap-2.5 ${locked ? 'opacity-60 pointer-events-none' : ''}`}
        >
          {COLOR_SCHEMES.map((s) => {
            const active = colorSchemeId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setColorScheme(s.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-[12px] md:text-[13px] font-medium cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1519] ${
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
