'use client';

// Customer self-serve estimate — the customer's OWN measured-roofline visual
// (ledger self-serve, S48). Shows the SAME live design the portal hero renders:
// their Street View photo with the analyzer's traced roofline, dimmed to dusk and
// recolorable with the same swatches as the sample gallery, so they see their own
// house lit in the color they pick.
//
// /api/estimate persists that design in a background after() task AFTER it responds,
// so this polls /api/estimate/design until the drawing lands, then fades it in. Pure
// enhancement: if the design never persists, this renders nothing and the result
// screen just shows the range — it never blocks or errors the customer.

import { useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { Scene } from '@/lib/design/sceneTypes';

const DesignCanvas = dynamic(() => import('@/components/design/DesignCanvas'), { ssr: false });

type DesignData = { scene: Scene; photoUrl: string | null; photoW: number | null; photoH: number | null };

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 12; // ~24s — the design is drawn in a background after() task.
const DUSK_BRIGHTNESS = 20; // match the gallery's evening look

// `footer` (e.g. the recolor swatches) renders only WHEN a design is present, so it
// never orphans below an empty box when the render never lands.
export function EstimateVisual({ quoteId, colorOverride, footer }: { quoteId: string; colorOverride?: string[] | null; footer?: ReactNode }) {
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
        // transient — retry until MAX_ATTEMPTS
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

  const litScene = design ? { ...design.scene, brightness: DUSK_BRIGHTNESS } : null;

  return (
    <div>
      <div className="est-framebox est-install">
        <div className="relative aspect-[4/3] w-full overflow-hidden">
          <div className="est-crop">
            {design && litScene ? (
              <DesignCanvas
                scene={litScene}
                photoUrl={design.photoUrl}
                photoW={design.photoW}
                photoH={design.photoH}
                colorOverride={colorOverride ?? null}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'linear-gradient(to bottom,#18221C,#0C1322)' }}>
                <div className="flex flex-col items-center gap-3" style={{ color: 'var(--est-cream-dim)' }}>
                  <div className="est-spinner" />
                  <p className="text-sm">Drawing your lights…</p>
                </div>
              </div>
            )}
          </div>
          {design && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/yule-site-logo-2.png"
              alt=""
              aria-hidden
              draggable={false}
              className="pointer-events-none select-none absolute z-20 bottom-[3%] right-[3%] h-auto w-[26%] min-w-[84px] max-w-[200px]"
              style={{ opacity: 0.55, filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))' }}
            />
          )}
        </div>
      </div>
      {design && (
        <p className="est-mock-cap" style={{ margin: '8px 0 0' }}>
          Here&apos;s our first pass at your roofline — we&apos;ll confirm the exact layout with you.
        </p>
      )}
      {design && footer}
    </div>
  );
}
