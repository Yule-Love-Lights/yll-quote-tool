'use client';

// Customer self-serve estimate — the measured-roofline visual (ledger self-serve,
// Slice 3). Shows the customer the SAME live design the portal hero renders: their
// Street View photo with the analyzer's traced roofline seeded onto it, so the
// price comes with visible evidence of where the lights go.
//
// /api/estimate persists that design in a background after() task AFTER it
// responds (so a slow render never delays the price), so this polls
// /api/estimate/design until the drawing lands, then fades it in. Pure
// enhancement: if the design never persists, this renders nothing and the result
// screen just shows the range — it never blocks or errors the customer.

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Scene } from '@/lib/design/sceneTypes';

// The portal's read-only Konva render, loaded only once we have a design to draw
// — keeps Konva out of the estimate page's initial (address-step) bundle.
const DesignCanvas = dynamic(() => import('@/components/design/DesignCanvas'), { ssr: false });

type DesignData = { scene: Scene; photoUrl: string | null; photoW: number | null; photoH: number | null };

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 8; // ~16s — the design is drawn in a background after() task

export function EstimateVisual({ quoteId }: { quoteId: string }) {
  const [design, setDesign] = useState<DesignData | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let alive = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      attempts += 1;
      try {
        const res = await fetch(`/api/estimate/design?quoteId=${encodeURIComponent(quoteId)}`);
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (res.ok && data.ready && data.scene) {
          setDesign({
            scene: data.scene as Scene,
            photoUrl: data.photoUrl ?? null,
            photoW: data.photoW ?? null,
            photoH: data.photoH ?? null,
          });
          return; // ready — stop polling
        }
      } catch {
        // transient — fall through and retry until MAX_ATTEMPTS
      }
      if (!alive) return;
      if (attempts >= MAX_ATTEMPTS) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [quoteId]);

  // Never drew → show nothing; the range card carries the result on its own.
  if (gaveUp && !design) return null;

  return (
    <div className="overflow-hidden rounded-2xl bg-slate-900 shadow-sm ring-1 ring-slate-200">
      <div className="relative aspect-[4/3] w-full">
        {design ? (
          <DesignCanvas
            scene={design.scene}
            photoUrl={design.photoUrl}
            photoW={design.photoW}
            photoH={design.photoH}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-slate-800 to-slate-900">
            <div className="flex flex-col items-center gap-3 text-slate-300">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-600 border-t-amber-400" />
              <p className="text-sm">Drawing your lights…</p>
            </div>
          </div>
        )}
      </div>
      {design && (
        <p className="px-4 py-2 text-center text-xs text-slate-300">
          Your roofline, measured from above — this is where your lights go.
        </p>
      )}
    </div>
  );
}
