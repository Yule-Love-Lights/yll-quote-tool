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
import { LogoWatermark } from '@/components/portal/LogoWatermark';

// Client-only (Konva) — same dynamic import the result-screen visual uses.
const DesignCanvas = dynamic(() => import('@/components/design/DesignCanvas'), { ssr: false });

// Evening brightness for the sample render — darker so the lights read at night.
const SAMPLE_BRIGHTNESS = 20;

export function BeforeAfter({ design, colorOverride }: { design: SampleDesign; colorOverride: string[] | null }) {
  const [split, setSplit] = useState(50);
  // Dim the real design to evening (its authored brightness is for daytime review).
  const litScene = { ...design.scene, brightness: SAMPLE_BRIGHTNESS };

  return (
    <div className="est-framebox est-install">
      <div className="relative aspect-[3/2] w-full overflow-hidden">
        {/* Crop the bottom (Street View "Google" footer) by scaling both layers
            identically from the top, so the design stays aligned. */}
        <div className="est-crop">
          {/* AFTER (bottom): real design, lit, with a dark evening sky. */}
          <div className="absolute inset-0">
            <DesignCanvas
              key={design.photoUrl}
              scene={litScene}
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
        <LogoWatermark />
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
