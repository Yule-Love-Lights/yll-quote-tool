'use client';

// Portal v6 — InteractiveHero. THE centerpiece of the snowglobe
// direction: the full viewport becomes the product. Tap a package and
// the home re-illuminates in real time with a warm amber bloom +
// brightness lift. Price tickers live on the photo too.
//
// Implementation:
//  - Photo layer: <img> with CSS filter varying by package (see
//    portal-snowglobe.css .portal-snow-stage-photo[data-level])
//  - Bloom layer: warm amber radial gradient with mix-blend screen,
//    opacity varies by package
//  - Flash: remounted via key++ on every package switch — CSS animation
//    plays once per mount, selling "lights just turned on"
//
// Reads + writes SelectionContext so the sticky bar + WhatsIncluded
// stay in sync. Passes the active package total through formatUsd.
//
// For mock data we have one "after" render; brightness + bloom fake
// the package differences. In production each package would swap to
// its own rendered composite image.

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import { LogoWatermark } from '../LogoWatermark';
import type { PortalPackage, PackageId, PortalDesign } from '../types';
import { isItemOnPhoto, type BulbColor } from '@/lib/design/sceneTypes';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';
import type { ServiceType } from '@/lib/serviceType';
import { portalPhotos } from '@/lib/portal/photos';
import { effectSpeedMs } from '@/lib/design/permanentScenes';
import { colorOf } from '@/components/design/editor-core/colors';
// The live design render uses Konva — load it client-side only (no SSR).
const DesignCanvas = dynamic(() => import('../../design/DesignCanvas'), { ssr: false });

export type InteractiveHeroProps = {
  firstName: string;
  afterUrl: string;
  alt: string;
  packages: PortalPackage[];
  lineItemCount: number; // total items (for "D" brightness scaling)
  // Linked design (#27 Phase 2). When present, the hero renders it live
  // instead of the static `afterUrl` image, with a daytime/lit toggle.
  design?: PortalDesign;
  // Global app settings (#32) applied to the live render so the customer sees
  // the configured palette + render tunables.
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
  // #96: the quote's service line — branches the hero headline ("your event"
  // vs "your home"). Undefined/holiday/permanent keep the default.
  serviceType?: ServiceType;
};

export function InteractiveHero({
  firstName,
  afterUrl,
  alt,
  packages,
  lineItemCount,
  design,
  palette,
  renderSettings,
  serviceType,
}: InteractiveHeroProps) {
  const {
    packageId,
    selectPackage,
    locked,
    currentTotal,
    currentDeposit,
    selectedItemIds,
    hiddenSceneItemIds,
    colorOverride,
    permanentEffect,
    showDaylight,
    activeName,
  } = useSelection();
  // #88 P6b-4 — permanent lights animate the live design per the SEPARATELY-chosen
  // effect (Solid/Chase/Fade), applied to whatever color the customer picked. A
  // motion effect → {effect,speedMs}; Solid or a non-permanent quote → null (static).
  // Only the HERO animates (perf); reprise/gallery stay static. A single-color pick
  // has nothing to move, so the animation controller no-ops it (stays solid).
  const heroAnimation = useMemo(() => {
    if (serviceType !== 'permanent') return null;
    return permanentEffect === 'chase' || permanentEffect === 'cycle'
      ? { effect: permanentEffect, speedMs: effectSpeedMs(permanentEffect) }
      : null;
  }, [serviceType, permanentEffect]);
  // #88 P6b-3/4 — the facade glow gradient for the active permanent color. Built from
  // the live palette (colorOverride), tinted via the configured palette hex. null (no
  // wash) for non-permanent quotes and for "as designed" (colorOverride null) — the
  // glow only shows for an explicit color. A motion effect sweeps it.
  const permGlow = useMemo(() => {
    if (serviceType !== 'permanent' || !design || !colorOverride || colorOverride.length === 0) return null;
    const hexOf = (id: string) => palette?.find((c) => c.id === id)?.hex ?? colorOf(id).hex;
    const hexes = colorOverride.map(hexOf);
    // Repeat the first color at the end so the 200%-wide sweep loops seamlessly.
    const stops = hexes.length === 1 ? `${hexes[0]}, ${hexes[0]}` : [...hexes, hexes[0]].join(', ');
    return { gradient: `linear-gradient(90deg, ${stops})`, motion: !!heroAnimation };
  }, [serviceType, design, colorOverride, palette, heroAnimation]);
  const [ready, setReady] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  // #13 multi-image: which photo the hero shows (null = the base photo). The
  // thumbnail strip below the stage swaps it; each photo renders ITS OWN items
  // (photoId-filtered scene) lit live, with the shared selection/color state.
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  // Shared helper (audit W4-019 — the [base, ...extraPhotos] + url-filter
  // construction used to be hand-built here too). Canonical numbering
  // (W4-029) comes from portalPhotos itself now via extraPhotoLabels.
  const photos = useMemo(() => (design ? portalPhotos(design) : []), [design]);
  const extraPhotos = useMemo(() => photos.filter((p) => p.id !== null), [photos]);
  const activeExtra = activePhotoId ? extraPhotos.find((p) => p.id === activePhotoId) ?? null : null;
  const activeUrl = activeExtra ? activeExtra.url : design?.photoUrl ?? null;
  const activeW = activeExtra ? activeExtra.w : design?.photoW ?? null;
  const activeH = activeExtra ? activeExtra.h : design?.photoH ?? null;
  const activeScene = useMemo(
    () =>
      design
        ? { ...design.scene, items: design.scene.items.filter((i) => isItemOnPhoto(i, activePhotoId)) }
        : null,
    [design, activePhotoId],
  );
  // A broken hero image (e.g. an expired signed URL) must never show the
  // browser's broken-image icon. When the daytime <img> or the static
  // next/image errors, fall back to a neutral night-sky poster instead.
  const [photoFailed, setPhotoFailed] = useState(false);
  const prevId = useRef<PackageId>(packageId);

  // Fire a bloom-flash any time the active package changes
  useEffect(() => {
    if (prevId.current !== packageId) {
      setFlashKey((k) => k + 1);
      prevId.current = packageId;
    }
  }, [packageId]);

  // Kick off the ken-burns after mount
  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 60);
    return () => window.clearTimeout(t);
  }, []);

  // For package "D" (Build Your Own), brightness scales with selection
  // count so toggling items in WhatsIncluded drives the stage live.
  const dBrightness =
    packageId === 'D'
      ? 0.55 + Math.min(1, selectedItemIds.size / Math.max(1, lineItemCount)) * 0.43
      : undefined;

  // Live total/deposit always come from the shared selection pricing (the
  // real selected items + tax), so tiers and custom read consistently (#18).
  const displayTotal = currentTotal;
  const displayDeposit = currentDeposit;

  // Match the mobile media box to the photo's actual aspect (#65 review): the box
  // cover-fits the photo, so an exact aspect = no crop in ANY direction for any
  // uploaded photo, not just the 8/5 Street View. Fallback to 8/5 when unknown.
  const mediaAspect = activeW && activeH ? `${activeW} / ${activeH}` : undefined;

  return (
    <section
      aria-labelledby="portal-snow-hero-heading"
      className="portal-snow-stage"
    >
      {/* Media box — photo + effects + heading. On mobile it's aspect-locked to the
          photo (full house, no crop, no letterbox); on desktop it fills the stage. */}
      <div
        className="portal-snow-stage-media"
        style={mediaAspect ? ({ ['--media-aspect' as string]: mediaAspect } as React.CSSProperties) : undefined}
      >
      {/* Photo layer — the live design when one is linked, else the static render */}
      {design ? (
        showDaylight && activeUrl && !photoFailed ? (
          // Before: the plain daytime photo (the ACTIVE photo's image, #13).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={activeUrl}
            alt={`${alt} — before installation, daytime`}
            className="portal-snow-stage-photo absolute inset-0 w-full h-full object-cover"
            data-ready={ready ? 'true' : 'false'}
            onError={() => setPhotoFailed(true)}
          />
        ) : showDaylight && activeUrl && photoFailed ? (
          // The daytime photo URL broke (e.g. expired signed URL): a neutral
          // night-sky poster instead of the browser's broken-image icon.
          <div
            aria-hidden
            className="portal-snow-stage-photo absolute inset-0 w-full h-full"
            style={{
              background:
                'radial-gradient(ellipse 90% 70% at 50% 30%, rgba(255,183,68,0.06), transparent 60%), #060B0F',
            }}
          />
        ) : (
          // After: the live, lit design rendered on the ACTIVE photo — its own
          // items only (#13), shared selection/color state.
          <DesignCanvas
            scene={activeScene ?? design.scene}
            photoUrl={activeUrl}
            photoW={activeW}
            photoH={activeH}
            hiddenIds={hiddenSceneItemIds}
            colorOverride={colorOverride}
            animation={heroAnimation}
            palette={palette}
            renderSettings={renderSettings}
            className="portal-snow-stage-photo absolute inset-0"
          />
        )
      ) : photoFailed ? (
        // The static render URL broke: a neutral night-sky poster instead of
        // the browser's broken-image icon.
        <div
          aria-hidden
          className="portal-snow-stage-photo"
          data-level={packageId}
          style={{
            background:
              'radial-gradient(ellipse 90% 70% at 50% 30%, rgba(255,183,68,0.06), transparent 60%), #060B0F',
          }}
        />
      ) : (
        <Image
          src={afterUrl}
          alt={alt}
          fill
          priority
          sizes="100vw"
          quality={85}
          className="portal-snow-stage-photo"
          data-level={packageId}
          data-ready={ready ? 'true' : 'false'}
          onError={() => setPhotoFailed(true)}
          style={
            dBrightness !== undefined
              ? ({ ['--brightness' as string]: dBrightness.toString() } as React.CSSProperties)
              : undefined
          }
        />
      )}

      {/* Warm amber bloom that scales with package level */}
      <div
        aria-hidden
        className="portal-snow-stage-bloom"
        data-level={packageId}
      />

      {/* #88 P6b-3 — permanent scene facade glow (over the photo/bloom, screen-blend).
          Only when a scene color is active; sweeps for a motion scene. */}
      {permGlow && (
        <div
          aria-hidden
          className="portal-perm-glow"
          data-motion={permGlow.motion ? 'true' : 'false'}
          style={{ ['--perm-glow' as string]: permGlow.gradient } as React.CSSProperties}
        />
      )}

      {/* Brand watermark (#45) — sits over the photo, outside the brightness-
          filtered photo element so it stays consistent across packages. */}
      <LogoWatermark />

      {/* One-shot warm flash on every package change */}
      {flashKey > 0 && (
        <div aria-hidden key={flashKey} className="portal-snow-flash" />
      )}

      {/* Bottom legibility scrim */}
      <div aria-hidden className="portal-snow-stage-scrim" />

      {/* Top — design heading (moved up from the bottom in #61) */}
      <div className="absolute top-0 left-0 right-0 pt-safe z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-[max(1.5rem,env(safe-area-inset-top))] md:pt-10">
          <p
            className="text-[11px] md:text-[12px] font-semibold tracking-[0.20em] uppercase text-[#FFB744] mb-2 md:mb-2.5"
            style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}
          >
            Your design
          </p>
          <h1
            id="portal-snow-hero-heading"
            className="font-display text-[26px] leading-[1.06] md:text-[54px] md:leading-[1.02] font-semibold text-[#F4ECD8] tracking-[-0.02em] max-w-2xl"
            style={{ textShadow: '0 1px 3px rgba(0,0,0,0.85), 0 2px 28px rgba(0,0,0,0.6)' }}
          >
            {serviceType === 'event' ? "Here's your event," : "Here's your home,"}{' '}
            <span className="italic text-[#FFD07A]">{firstName}</span>.
          </h1>
        </div>
      </div>
      </div>{/* /.portal-snow-stage-media */}

      {/* Bottom content — price + package selector. On mobile it flows BELOW the
          aspect-locked photo box; on desktop it overlays the bottom of the stage. */}
      <div className="relative z-10 md:absolute md:bottom-0 md:left-0 md:right-0 pb-safe">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 md:pb-14">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8 items-end">
            {/* Live price (the "Here's your home" heading moved to the top in #61) */}
            <div className="md:col-span-7">
              <div className="flex items-baseline gap-3 flex-wrap">
                <span
                  className="portal-snow-price font-display text-[36px] md:text-[52px] font-bold text-[#F4ECD8]"
                  style={{ textShadow: '0 2px 18px rgba(0,0,0,0.6)' }}
                >
                  {formatUsd(displayTotal)}
                </span>
                <span className="text-[13px] md:text-[14px] text-[#F4ECD8]/75">
                  incl. tax ·{' '}
                  <span className="tabular-nums text-[#FFD07A]">{formatUsd(displayDeposit)}</span>{' '}
                  deposit
                </span>
              </div>
              {/* #13 multi-image: thumbnail strip — BELOW the price, in line with
                  the packages (Jason's CP3 call; on phones the price stacks above
                  the strip naturally). Tap to flip the hero to that photo, lit
                  with its own items. Hidden for single-photo designs. */}
              {design && extraPhotos.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1 mt-4" role="tablist" aria-label="Photos of your home">
                  {photos.map((p) => {
                    const active = p.id === activePhotoId;
                    return (
                      <button
                        key={p.id ?? 'base'}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => { setPhotoFailed(false); setActivePhotoId(p.id); }}
                        className={`shrink-0 rounded-md overflow-hidden border-2 transition-colors ${
                          active ? 'border-[#FFB744]' : 'border-[#2a3a30] hover:border-[#4a5a50]'
                        }`}
                        title={p.title}
                      >
                        {p.url ? (
                          // Perf fix (audit W4-030): these are full-resolution
                          // signed photo URLs with no resize proxy available, so
                          // this can't be downsized server-side without new infra
                          // (next/image's remotePatterns don't cover the Supabase
                          // storage host). Explicit width/height HTML attributes
                          // (not just the CSS box) + native lazy-loading keep the
                          // layout cost fixed and defer the fetch for any chip
                          // scrolled out of the strip, instead of eagerly
                          // downloading every extra photo at full size on mount.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.url}
                            alt={p.title}
                            width={76}
                            height={50}
                            loading="lazy"
                            decoding="async"
                            className="w-[76px] h-[50px] object-cover block"
                          />
                        ) : (
                          <span className="w-[76px] h-[50px] block bg-[#101a14]" />
                        )}
                        <span className={`block text-[10px] px-1 py-0.5 text-center truncate max-w-[76px] ${
                          active ? 'text-[#FFD07A] bg-[#1d2b22]' : 'text-[#9fb8a8] bg-[#101a14]'
                        }`}>
                          {p.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Package selector */}
            <div className="md:col-span-5">
              <p className="text-[10px] md:text-[11px] font-semibold tracking-[0.22em] uppercase text-[#F4ECD8]/70 mb-2.5">
                {locked ? 'Your selected package' : 'Tap to re-illuminate'}
              </p>
              <div
                role="radiogroup"
                aria-label="Choose your lighting package"
                aria-disabled={locked || undefined}
                className={`grid grid-cols-2 gap-2 md:gap-2.5 ${locked ? 'opacity-60 pointer-events-none' : ''}`}
              >
                {packages.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={packageId === p.id}
                    onClick={() => selectPackage(p.id)}
                    data-active={packageId === p.id}
                    className="portal-snow-pack-tab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]"
                  >
                    {/* Internal ids stay A/B/C/D; the customer sees "Tier N" by
                        position (so omitting an unavailable tier stays contiguous)
                        + "Custom" for D. The "· recommended" badge and the D name
                        track the live selection so they don't out-claim the
                        sticky bar once the customer edits the recommendation. */}
                    <span className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.20em] uppercase text-[#FFB744]">
                      {p.id === 'D' && serviceType !== 'permanent' && serviceType !== 'event' ? 'Custom' : `Tier ${i + 1}`}
                      {p.recommended && (packageId !== 'D' || activeName === p.name) && (
                        <span className="text-[9px] tracking-[0.14em] text-[#FFD07A]/90 normal-case">
                          · recommended
                        </span>
                      )}
                    </span>
                    <span className="font-display text-[17px] md:text-[18px] font-semibold text-[#F4ECD8] leading-[1.15] mt-0.5">
                      {p.id === 'D' && packageId === 'D' ? activeName : p.name}
                    </span>
                    <span className="portal-snow-price text-[14px] md:text-[15px] font-semibold text-[#F4ECD8]/85 mt-1">
                      {p.id === 'D'
                        ? packageId === 'D'
                          ? formatUsd(currentTotal)
                          : p.includedItemIds.length > 0
                            ? formatUsd(p.total)
                            : 'You pick'
                        : formatUsd(p.total)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
