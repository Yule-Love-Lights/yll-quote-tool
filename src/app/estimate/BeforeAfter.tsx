'use client';

// Customer self-serve estimate — before/after hero (ledger self-serve, S48).
//
// A REAL completed-job home revealed by a drag slider: the "with lights" side is the
// actual staff-traced design rendered through DesignCanvas (the same engine as the
// portal and the customer's own result), and the "before" is the plain photo clipped
// over it. Swatches recolor the render live via colorOverride.

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { SampleDesign } from '@/lib/designs';
import { SCHEME_COLOR_IDS, type SchemeKey } from './estimateSamples';

// Client-only (Konva) — same dynamic import the result-screen visual uses.
const DesignCanvas = dynamic(() => import('@/components/design/DesignCanvas'), { ssr: false });

export function BeforeAfter({ design, scheme }: { design: SampleDesign; scheme: SchemeKey }) {
  const [split, setSplit] = useState(50);
  const colorOverride = SCHEME_COLOR_IDS[scheme] ?? null;

  return (
    <div className="est-framebox">
      <div className="relative aspect-[3/2] w-full">
        {/* AFTER (bottom): the real design render, lit. Keyed on the photo so a
            style switch remounts cleanly. */}
        <div className="absolute inset-0">
          <DesignCanvas
            key={design.photoUrl}
            scene={design.scene}
            photoUrl={design.photoUrl}
            photoW={design.photoW}
            photoH={design.photoH}
            colorOverride={colorOverride}
          />
        </div>
        {/* BEFORE (top): plain photo, clipped to the left of the handle. */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={design.photoUrl} alt="Home before lights" className="absolute inset-0 h-full w-full object-cover" />
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
