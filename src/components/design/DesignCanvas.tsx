'use client';

import { useEffect, useRef, useState } from 'react';
import type { Scene, BulbColor } from '@/lib/design/sceneTypes';
import type { ReadOnlyDesignController } from './editor-core/render-readonly';
import { setPalette } from './editor-core/colors';
import { setRenderSettings, type RenderSettings } from './editor-core/renderSettings';

type Props = {
  scene: Scene;
  photoUrl: string | null;
  photoW: number | null;
  photoH: number | null;
  className?: string;
  /** Scene-item ids to hide (#27 D — portal toggle filter). */
  hiddenIds?: Set<string>;
  /**
   * Whole-house light color/pattern override (#10): palette color ids the light
   * items recolor to, or null for "as designed". Updated live (no remount).
   */
  colorOverride?: string[] | null;
  /**
   * Global app settings (#32) applied before render so the customer sees what
   * staff configured: the editable palette + render tunables (e.g. spritzer
   * density). Omitted ⇒ editor-core factory defaults.
   */
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
};

// Read-only React wrapper that mounts the live design render (Konva) into a
// host div, client-side only (dynamic import keeps Konva out of SSR). Used by
// the portal hero to show the customer's actual design. View-only — no editing.
export default function DesignCanvas({ scene, photoUrl, photoW, photoH, className, hiddenIds, colorOverride, palette, renderSettings }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<ReadOnlyDesignController | null>(null);
  // Audit fix (g11): track render lifecycle so the hero is never blank or
  // permanently empty. `ready` flips true once the Konva stage resolves (until
  // then a dimmed poster of the base photo shows instead of a blank div);
  // `failed` flips true if the dynamic import / render rejects (e.g. an expired
  // signed photo URL), falling back to the static photo so it never stays empty.
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Mount/teardown the Konva stage — only when the scene or photo changes.
  // hiddenIds is intentionally NOT a mount dependency: a toggle updates the
  // filter in place via the effect below, never remounting/reloading the photo.
  // The mount closure reads the current hiddenIds, which is correct at each
  // (re)mount (scene/photo change re-renders with the latest hiddenIds first).
  useEffect(() => {
    let cancelled = false;
    // Reset lifecycle for this (re)mount (scene/photo change).
    setReady(false);
    setFailed(false);

    void (async () => {
      const host = hostRef.current;
      if (!host) return;
      // Audit fix (g11): wrap the import + render so a failure (e.g. an expired
      // signed photo URL or a Konva load error) falls back to the static photo
      // instead of leaving the hero permanently empty.
      try {
        const { renderReadOnlyDesign } = await import('./editor-core/render-readonly');
        if (cancelled) return;
        // Apply global app settings (#32) before rendering so the portal matches
        // what staff configured (palette + spritzer density, etc.).
        if (palette && palette.length > 0) setPalette(palette);
        if (renderSettings) setRenderSettings(renderSettings);
        const ctrl = await renderReadOnlyDesign(host, {
          scene,
          photoUrl,
          photoW,
          photoH,
          hiddenIds: hiddenIds ?? null,
          colorOverride: colorOverride ?? null,
        });
        if (cancelled) {
          ctrl.destroy();
          return;
        }
        ctrlRef.current = ctrl;
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      ctrlRef.current?.destroy();
      ctrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenIds + colorOverride handled by the live effects below; remounting on them would reload the photo.
  }, [scene, photoUrl, photoW, photoH]);

  // Live toggle filter — re-render the draw layer only (no remount/flicker).
  useEffect(() => {
    ctrlRef.current?.setHidden(hiddenIds ?? null);
  }, [hiddenIds]);

  // Live color override (#10) — re-render the draw layer only (no remount). The
  // override array ref is stable per scheme (from the COLOR_SCHEMES constant),
  // so this only fires when the customer actually switches schemes.
  useEffect(() => {
    ctrlRef.current?.setColorOverride(colorOverride ?? null);
  }, [colorOverride]);

  // Audit fix (g11): never render a bare empty div.
  //  - Until the Konva stage resolves, show a dimmed/blurred poster of the base
  //    photo as a skeleton so the hero isn't blank on slow networks.
  //  - If the live render failed, fall back to the static photo so the hero is
  //    never permanently empty.
  return (
    <div ref={hostRef} className={className} style={{ position: 'relative' }}>
      {failed && photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        !ready &&
        photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 w-full h-full object-cover"
            style={{ filter: 'blur(8px) brightness(0.6)', transform: 'scale(1.05)' }}
          />
        )
      )}
    </div>
  );
}
