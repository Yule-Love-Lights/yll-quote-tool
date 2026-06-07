'use client';

import { useEffect, useRef } from 'react';
import type { Scene } from '@/lib/design/sceneTypes';

type Props = {
  scene: Scene;
  photoUrl: string | null;
  photoW: number | null;
  photoH: number | null;
  className?: string;
};

// Read-only React wrapper that mounts the live design render (Konva) into a
// host div, client-side only (dynamic import keeps Konva out of SSR). Used by
// the portal hero to show the customer's actual design. View-only — no editing.
export default function DesignCanvas({ scene, photoUrl, photoW, photoH, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let destroy: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const host = hostRef.current;
      if (!host) return;
      const { renderReadOnlyDesign } = await import('./editor-core/render-readonly');
      if (cancelled) return;
      destroy = await renderReadOnlyDesign(host, { scene, photoUrl, photoW, photoH });
      if (cancelled) {
        destroy?.();
        destroy = null;
      }
    })();

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [scene, photoUrl, photoW, photoH]);

  return <div ref={hostRef} className={className} />;
}
