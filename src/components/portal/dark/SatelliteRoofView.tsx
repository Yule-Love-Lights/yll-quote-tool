'use client';

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

import { useState, type CSSProperties } from 'react';
import type { PortalDesign } from '../types';
import { selectDrawableLineGroups } from '@/lib/portal/satelliteLines';

export function SatelliteRoofView({
  design,
  className = 'mt-10 md:mt-12',
  inRow = false,
}: {
  design: PortalDesign;
  // Root wrapper classes — defaults to its own top margin; the caller can
  // override (e.g. to '' when placed in the side-by-side grid, #51).
  className?: string;
  // #51 side-by-side row: at lg+ the (square) image becomes a fixed height
  // (var(--row-h), set by the parent row) so it matches the front-view card's
  // height. The img keeps its natural aspect (h-full w-auto) so the SVG overlay
  // stays pixel-aligned to the roof — no object-cover/contain distortion.
  inRow?: boolean;
}) {
  const { satelliteUrl, satelliteLines, satelliteW, satelliteH } = design;
  const groups = selectDrawableLineGroups(satelliteLines);
  // a11y/consistency fix (W4-026): a broken/expired satellite URL used to fall
  // through to the browser's broken-image icon inside "Where the lights go"
  // (the hero already guards its images the same way). Hide the whole section
  // on error rather than showing a partial/broken card — there's no useful
  // fallback poster for a satellite trace.
  const [failed, setFailed] = useState(false);
  if (!satelliteUrl || groups.length === 0 || failed) return null;

  // Numeric aspect (w/h) for the #51 row: card width = row-height × this. Square
  // satellite pulls → 1. The img fills the matched-aspect card, so the overlay
  // stays pixel-aligned.
  const cardAr = satelliteW && satelliteH ? satelliteW / satelliteH : 1;

  return (
    <section
      className={`${className} ${inRow ? 'lg:flex-none lg:[width:calc(var(--row-h)*var(--card-ar))]' : ''}`}
      style={inRow ? ({ ['--card-ar']: cardAr } as CSSProperties) : undefined}
      aria-labelledby="portal-dark-satellite-heading"
    >
      <p
        id="portal-dark-satellite-heading"
        className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3"
      >
        Where the lights go
      </p>
      <div
        className={`relative overflow-hidden rounded-2xl border border-[#243029] bg-[#18221C] ${
          inRow
            ? 'w-full max-w-[640px] lg:w-full lg:max-w-none lg:[height:var(--row-h)]'
            : 'w-full max-w-[640px]'
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={satelliteUrl}
          alt="Satellite view of your home with the roofline lighting plan marked"
          className={`block select-none ${inRow ? 'w-full h-auto lg:h-full lg:w-full' : 'w-full h-auto'}`}
          draggable={false}
          loading="lazy"
          onError={() => setFailed(true)}
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
