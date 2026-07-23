'use client';

// Customer self-serve estimate — before/after hero (ledger self-serve, S48).
//
// A REAL completed-job home revealed by a drag slider: the "with lights" side is the
// actual staff-traced design rendered through DesignCanvas (same engine as the
// portal), dimmed to evening with a dark sky so the bulbs pop; the "before" is the
// plain photo clipped over it. Carries the YLL logo + gold trim like the quote tool.
// Color schemes recolor the render live via colorOverride.

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { SampleDesign } from '@/lib/designs';

// Client-only (Konva) — same dynamic import the result-screen visual uses.
const DesignCanvas = dynamic(() => import('@/components/design/DesignCanvas'), { ssr: false });

export function BeforeAfter({ design, colorOverride }: { design: SampleDesign; colorOverride: string[] | null }) {
  const [split, setSplit] = useState(50);

  return (
    <div className="est-framebox est-install">
      <div className="relative aspect-[3/2] w-full overflow-hidden">
        {/* Crop the bottom (Street View "Google" footer) by scaling both layers
            identically from the top, so the design stays aligned. */}
        <div className="est-crop">
          {/* AFTER (bottom): the real design, as the portal renders it — the dark
              sky is a top-only gradient (est-sky), NOT a whole-image dim. */}
          <div className="absolute inset-0">
            <DesignCanvas
              key={design.photoUrl}
              scene={design.scene}
              photoUrl={design.photoUrl}
              photoW={design.photoW}
              photoH={design.photoH}
              colorOverride={colorOverride}
            />
            <div className="est-sky" aria-hidden />
          </div>
          {/* BEFORE (top): plain photo, clipped to the left of the handle. */}
          <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={design.photoUrl} alt="Home before lights" className="absolute inset-0 h-full w-full object-cover" />
          </div>
        </div>
        {/* YLL brand mark — bottom-left (Naldo). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/yule-site-logo-2.png"
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none select-none absolute z-20 bottom-[3%] left-[3%] h-auto w-[26%] min-w-[84px] max-w-[200px]"
          style={{ opacity: 0.55, filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))' }}
        />
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
