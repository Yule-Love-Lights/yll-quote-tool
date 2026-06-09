'use client';

import { useEffect, useRef } from 'react';
import type { Scene } from '@/lib/design/sceneTypes';
import type { ReadOnlyDesignController } from './editor-core/render-readonly';

type Props = {
  scene: Scene;
  photoUrl: string | null;
  photoW: number | null;
  photoH: number | null;
  className?: string;
  /** Scene-item ids to hide (#27 D — portal toggle filter). */
  hiddenIds?: Set<string>;
};

// Read-only React wrapper that mounts the live design render (Konva) into a
// host div, client-side only (dynamic import keeps Konva out of SSR). Used by
// the portal hero to show the customer's actual design. View-only — no editing.
export default function DesignCanvas({ scene, photoUrl, photoW, photoH, className, hiddenIds }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<ReadOnlyDesignController | null>(null);

  // Mount/teardown the Konva stage — only when the scene or photo changes.
  // hiddenIds is intentionally NOT a mount dependency: a toggle updates the
  // filter in place via the effect below, never remounting/reloading the photo.
  // The mount closure reads the current hiddenIds, which is correct at each
  // (re)mount (scene/photo change re-renders with the latest hiddenIds first).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const host = hostRef.current;
      if (!host) return;
      const { renderReadOnlyDesign } = await import('./editor-core/render-readonly');
      if (cancelled) return;
      const ctrl = await renderReadOnlyDesign(host, {
        scene,
        photoUrl,
        photoW,
        photoH,
        hiddenIds: hiddenIds ?? null,
      });
      if (cancelled) {
        ctrl.destroy();
        return;
      }
      ctrlRef.current = ctrl;
    })();

    return () => {
      cancelled = true;
      ctrlRef.current?.destroy();
      ctrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenIds handled by the live-filter effect below; remounting on it would reload the photo.
  }, [scene, photoUrl, photoW, photoH]);

  // Live toggle filter — re-render the draw layer only (no remount/flicker).
  useEffect(() => {
    ctrlRef.current?.setHidden(hiddenIds ?? null);
  }, [hiddenIds]);

  return <div ref={hostRef} className={className} />;
}
