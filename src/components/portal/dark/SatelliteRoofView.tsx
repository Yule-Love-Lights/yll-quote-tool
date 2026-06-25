// #51 — Satellite roof view. A top-down satellite photo of the customer's home
// with the traced roofline lines overlaid (red = front roofline, blue = ridge &
// sides, green = C9), so they see exactly where their roof lights will run.
// Placed inside "What's Included", right under the lit DesignReprise render and
// above "Optional add-ons" (Naldo's placement).
//
// Static + read-only (no zoom/pan) — an <img> with a normalized-coordinate SVG
// overlay, mirroring the builder's satellite render (QuoteBuilder.tsx) with the
// editing handles stripped. The image is rendered at its NATURAL aspect
// (w-full h-auto, no object-cover / no max-height) so the photo and the
// preserveAspectRatio="none" overlay always fill the exact same box and the
// lines stay locked to the roof — capping height instead would desync them.
// Width is capped at the satellite's native 640px so it never upscales.
//
// Hides entirely (returns null) when the quote has no satellite image or no
// drawable traced lines — i.e. manual-upload / pre-migration / never-"Calculated"
// quotes.

import type { PortalDesign } from '../types';
import { selectDrawableLineGroups } from '@/lib/portal/satelliteLines';

export function SatelliteRoofView({ design }: { design: PortalDesign }) {
  const { satelliteUrl, satelliteLines } = design;
  const groups = selectDrawableLineGroups(satelliteLines);
  if (!satelliteUrl || groups.length === 0) return null;

  return (
    <section className="mt-10 md:mt-12" aria-labelledby="portal-dark-satellite-heading">
      <p
        id="portal-dark-satellite-heading"
        className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3"
      >
        Where the lights go
      </p>
      <div className="relative w-full max-w-[640px] overflow-hidden rounded-2xl border border-[#243029] bg-[#18221C]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={satelliteUrl}
          alt="Satellite view of your home with the roofline lighting plan marked"
          className="block w-full h-auto select-none"
          draggable={false}
          loading="lazy"
        />
        {/* Decorative overlay — the legend below conveys the meaning in text.
            preserveAspectRatio="none" maps the normalized 0–1 line coords onto
            the image box; since the <img> sets the box via its natural aspect,
            the two always coincide. */}
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
          aria-hidden
        >
          {groups.flatMap((g) =>
            g.lines.map((line, i) => (
              <polyline
                key={`${g.key}-${i}`}
                points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke={g.color}
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )),
          )}
        </svg>
      </div>
      {/* Legend — names each colored line in plain language. */}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {groups.map((g) => (
          <span key={g.key} className="inline-flex items-center gap-2 text-[13px] text-[#A89F87]">
            <span
              aria-hidden
              className="inline-block w-5 h-[3px] rounded-full"
              style={{ backgroundColor: g.color }}
            />
            {g.label}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[13px] text-[#A89F87] leading-[1.6]">
        A top-down view of your home — the colored lines mark exactly where we&apos;ll run your roof lights.
      </p>
    </section>
  );
}
