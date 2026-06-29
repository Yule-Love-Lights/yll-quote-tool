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
  // Loading/error state drives the sibling overlay (skeleton while the Konva
  // import + render are in flight; a static-photo fallback if they reject —
  // e.g. an expired signed URL). Never set synchronously in the effect body
  // (that triggers cascading renders); only after an await inside the async
  // flow below, so the reset on remount happens off the render path too.
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

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
      try {
        const { renderReadOnlyDesign } = await import('./editor-core/render-readonly');
        if (cancelled) return;
        // Reset to the loading state AFTER the first await (not synchronously in
        // the effect body) so a scene/photo change shows the skeleton again
        // without a synchronous setState-in-effect.
        setReady(false);
        setFailed(false);
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
        // Dynamic import or render rejected (e.g. an expired signed photo URL).
        // Surface the static-photo fallback instead of a permanent blank.
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

  // Relatively-positioned WRAPPER carries the layout className. Inside it, the
  // Konva host is its OWN element with NO React children (Konva clears it via
  // innerHTML; React must not own anything inside it — React 19 DOM-ownership).
  // The skeleton/fallback is a SIBLING overlay, never a child of the host.
  //
  // width/height:100% so the wrapper FILLS the box the caller sized. Callers
  // position us with `absolute inset-0`, but our inline `position:relative` wins
  // over that `absolute` → the `inset-0` turns inert. Without an explicit
  // 100%/100% the wrapper then collapses to 0 height and Konva renders a 1px-tall
  // canvas (the "Your home, lit up" reprise dark-box bug). The hero was spared
  // only because its CSS class (.portal-snow-stage-photo) already sets height:100%.
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {(!ready || failed) && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            // A dim poster: the static photo when we have one (so the fallback
            // shows the home, not a void), under a faint scrim. While loading
            // it sits beneath the Konva render; once ready it's hidden.
            backgroundColor: '#0b1117',
            backgroundImage: photoUrl ? `url("${photoUrl}")` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            // Skeleton dims the poster; the failed fallback shows it near-clear
            // (the static photo IS the graceful degradation, no broken canvas).
            opacity: failed ? 1 : photoUrl ? 0.55 : 1,
            transition: 'opacity 300ms ease',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
