'use client';

// Customer self-serve estimate — before/after hero (ledger self-serve, S48).
//
// A house photo with the holiday-light design revealed by a drag slider. The
// "with lights" side is the REAL design render (DesignCanvas → renderReadOnlyDesign)
// — the exact same engine that draws the customer's own house on the result screen
// and powers the portal — NOT a hand-drawn overlay. The design is seeded from the
// style's roofline geometry (estimateSamples.ts) and dimmed to evening so the bulbs
// glow. The "before" is the plain daytime photo, clipped over the lit render.
//
// Swatches recolor the render live via DesignCanvas's colorOverride (the same
// whole-house color path the portal color picker uses).

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { buildSampleScene, SCHEME_COLOR_IDS, SAMPLE_PHOTO_W, SAMPLE_PHOTO_H, type SampleStyle, type SchemeKey } from './estimateSamples';

// Client-only (Konva) — same dynamic import the result-screen visual uses.
const DesignCanvas = dynamic(() => import('@/components/design/DesignCanvas'), { ssr: false });

export function BeforeAfter({ style, scheme }: { style: SampleStyle; scheme: SchemeKey }) {
  const [split, setSplit] = useState(50);
  const scene = useMemo(() => buildSampleScene(style), [style]);
  const colorOverride = SCHEME_COLOR_IDS[scheme] ?? null;

  return (
    <div className="est-framebox">
      <div className="relative aspect-[3/2] w-full">
        {/* AFTER (bottom): the real design render, lit. */}
        <div className="absolute inset-0">
          <DesignCanvas
            scene={scene}
            photoUrl={style.photo}
            photoW={SAMPLE_PHOTO_W}
            photoH={SAMPLE_PHOTO_H}
            colorOverride={colorOverride}
          />
        </div>
        {/* BEFORE (top): plain daytime photo, clipped to the left of the handle. */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={style.photo} alt={`${style.label} home`} className="absolute inset-0 h-full w-full object-cover" />
        </div>
        <span className="est-ba-label est-ba-label-l">Before</span>
        <span className="est-ba-label est-ba-label-r">With lights</span>
        <div className="est-ba-handle" style={{ left: `${split}%` }} />
        <input
          type="range"
          min={0}
          max={100}
          value={split}
          onChange={(e) => setSplit(Number(e.target.value))}
          aria-label="Drag to compare before and with lights"
          className="est-ba-range"
        />
      </div>
    </div>
  );
}
