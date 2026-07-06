'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import type { Scene, BulbColor } from '@/lib/design/sceneTypes';
import type { ReadOnlyDesignController } from './editor-core/render-readonly';
import { setPalette } from './editor-core/colors';
import { setRenderSettings, type RenderSettings } from './editor-core/renderSettings';
import { buildRenderColorMap, offeredFromLists, type OfferedColorLists } from '@/lib/inventory/resolveInstalls';
import { sceneColorsAt, type SceneEffect } from '@/lib/design/permanentScenes';

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
  /**
   * #88 P6b-3 — permanent-only scene ANIMATION. When set to a motion effect
   * (chase/cycle), a lightweight stepper rotates the `colorOverride` palette over
   * time so the live design animates. null / static effect → the design renders
   * static (unchanged behavior). Honors prefers-reduced-motion and pauses while the
   * canvas is scrolled off-screen. Editor-core is untouched — this drives the
   * existing render's cheap setColorOverride imperatively.
   */
  animation?: { effect: SceneEffect; speedMs: number } | null;
};

// #110 W4-006 — module-level cache so every DesignCanvas instance on a page
// (hero + reprise + N-photo gallery) shares ONE /api/inventory/offered-colors
// request instead of firing one each. Mirrors the fetchAppSettings() pattern
// in lib/clientSettings.ts. Colors are page-static (from app_settings), so a
// plain in-flight/resolved promise cache (no invalidation) is correct here —
// unlike clientSettings, nothing on this page ever writes offered colors.
let offeredColorsCache: Promise<OfferedColorLists | null> | null = null;
function fetchOfferedColors(): Promise<OfferedColorLists | null> {
  if (!offeredColorsCache) {
    offeredColorsCache = fetch('/api/inventory/offered-colors')
      .then((r) => (r.ok ? (r.json() as Promise<OfferedColorLists>) : null))
      .catch((e) => {
        console.warn('[DesignCanvas] offered-colors fetch failed', e);
        return null;
      });
  }
  return offeredColorsCache;
}

// Read-only React wrapper that mounts the live design render (Konva) into a
// host div, client-side only (dynamic import keeps Konva out of SSR). Used by
// the portal hero to show the customer's actual design. View-only — no editing.
export default function DesignCanvas({ scene, photoUrl, photoW, photoH, className, hiddenIds, colorOverride, palette, renderSettings, animation }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<ReadOnlyDesignController | null>(null);
  // Loading/error state drives the sibling overlay (skeleton while the Konva
  // import + render are in flight; a static-photo fallback if they reject —
  // e.g. an expired signed URL). Never set synchronously in the effect body
  // (that triggers cascading renders); only after an await inside the async
  // flow below, so the reset on remount happens off the render path too.
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // #92 — the offered solid colors per type (from bindings), fetched once.
  const [offeredColors, setOfferedColors] = useState<OfferedColorLists | null>(null);
  useEffect(() => {
    let alive = true;
    fetchOfferedColors().then((d) => { if (alive) setOfferedColors(d); });
    return () => { alive = false; };
  }, []);
  // Resolve the customer's whole-house choice to PER-ITEM render colors — each light
  // item shows exactly the strand/solid we'd install (#92). null = as-designed. We
  // hold at as-designed until offered-colors load (offeredColors == null) so the
  // render never flashes the wrong fallback color mid-fetch.
  const colorMap = useMemo(
    () => (offeredColors == null ? null : buildRenderColorMap(scene.items, colorOverride ?? null, offeredFromLists(offeredColors))),
    [scene, colorOverride, offeredColors],
  );

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
          colorOverride: colorMap,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenIds + colorMap handled by the live effects below; remounting on them would reload the photo.
  }, [scene, photoUrl, photoW, photoH]);

  // Live toggle filter — re-render the draw layer only (no remount/flicker).
  useEffect(() => {
    ctrlRef.current?.setHidden(hiddenIds ?? null);
  }, [hiddenIds]);

  // Live color override (#10/#92) — re-render the draw layer only (no remount).
  // colorMap (memoized) changes only when the scheme, scene, or offered-colors
  // change, so this fires when the customer actually switches schemes.
  useEffect(() => {
    ctrlRef.current?.setColorOverride(colorMap);
  }, [colorMap]);

  // #88 P6b-3 — permanent scene ANIMATION. A lightweight stepper (NOT a per-pixel
  // loop): while the canvas is on-screen + reduce-motion is off, advance the
  // `colorOverride` palette one rotation every `speedMs` and re-apply via the
  // render's cheap setColorOverride (no remount). chase rotates the palette (the
  // pattern travels along each strand); cycle steps a single color (whole-house
  // fade). Static / null animation → this is inert and the effect above renders the
  // resting colors. rAF auto-pauses on a hidden tab; an IntersectionObserver pauses
  // it when scrolled off-screen; cleanup restores the resting colorMap.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    const base = colorOverride ?? null;
    const anim = animation ?? null;
    const isMotion =
      !!anim && (anim.effect === 'chase' || anim.effect === 'cycle') && !!base && base.length > 1 && anim.speedMs > 0;
    // Bail (leave the static colorMap effect in charge) when there's nothing to
    // animate, the render isn't mounted yet, offered colors haven't loaded, or the
    // viewer prefers reduced motion.
    if (!ctrl || !ready || !isMotion || offeredColors == null) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const offered = offeredFromLists(offeredColors);
    const host = hostRef.current;
    let raf = 0;
    let startTs = 0;
    let lastStep = -1;

    const rest = () => ctrl.setColorOverride(buildRenderColorMap(scene.items, base, offered));
    const tick = (ts: number) => {
      if (!startTs) startTs = ts;
      const elapsed = ts - startTs;
      const step = Math.floor(elapsed / anim!.speedMs);
      if (step !== lastStep) {
        lastStep = step;
        const rotated = sceneColorsAt(base, anim!.effect, elapsed, anim!.speedMs);
        ctrl.setColorOverride(buildRenderColorMap(scene.items, rotated, offered));
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf) {
        startTs = 0;
        lastStep = -1;
        raf = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    // Pause the loop entirely while the canvas is off-screen (battery on mobile);
    // resume + restart the cycle when it scrolls back into view.
    let io: IntersectionObserver | null = null;
    if (host && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) start();
          else {
            stop();
            rest();
          }
        },
        { threshold: 0.05 },
      );
      io.observe(host);
    } else {
      start();
    }

    return () => {
      stop();
      io?.disconnect();
      rest();
    };
  }, [animation, colorOverride, ready, offeredColors, scene]);

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
