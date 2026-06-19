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

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { PlayCircle, MapPin, Sun } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import type { PortalPackage, PackageId, PortalDesign } from '../types';
import type { BulbColor } from '@/lib/design/sceneTypes';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';
// The live design render uses Konva — load it client-side only (no SSR).
const DesignCanvas = dynamic(() => import('../../design/DesignCanvas'), { ssr: false });

export type InteractiveHeroProps = {
  firstName: string;
  address: string;
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
};

export function InteractiveHero({
  firstName,
  address,
  afterUrl,
  alt,
  packages,
  lineItemCount,
  design,
  palette,
  renderSettings,
}: InteractiveHeroProps) {
  const {
    packageId,
    selectPackage,
    currentTotal,
    currentDeposit,
    selectedItemIds,
    hiddenSceneItemIds,
    colorOverride,
  } = useSelection();
  const [ready, setReady] = useState(false);
  // Daytime ⇄ lit-design toggle (only shown when a design with a photo exists).
  const [showBefore, setShowBefore] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
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

  const scrollToVideo = () => {
    document.getElementById('portal-snow-walkthrough')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  return (
    <section
      aria-labelledby="portal-snow-hero-heading"
      className="portal-snow-stage"
    >
      {/* Photo layer — the live design when one is linked, else the static render */}
      {design ? (
        showBefore && design.photoUrl ? (
          // Before: the plain daytime photo (the design's base image).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={design.photoUrl}
            alt={`${alt} — before installation, daytime`}
            className="portal-snow-stage-photo absolute inset-0 w-full h-full object-cover"
            data-ready={ready ? 'true' : 'false'}
          />
        ) : (
          // After: the live, lit design rendered on the photo.
          <DesignCanvas
            scene={design.scene}
            photoUrl={design.photoUrl}
            photoW={design.photoW}
            photoH={design.photoH}
            hiddenIds={hiddenSceneItemIds}
            colorOverride={colorOverride}
            palette={palette}
            renderSettings={renderSettings}
            className="portal-snow-stage-photo absolute inset-0"
          />
        )
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

      {/* One-shot warm flash on every package change */}
      {flashKey > 0 && (
        <div aria-hidden key={flashKey} className="portal-snow-flash" />
      )}

      {/* Bottom legibility scrim */}
      <div aria-hidden className="portal-snow-stage-scrim" />

      {/* Top-left eyebrow */}
      <div className="absolute top-0 left-0 right-0 pt-safe z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 md:pt-8 flex items-center justify-between gap-4">
          <p className="flex items-center gap-1.5 text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#F4ECD8]/85">
            <MapPin className="w-3.5 h-3.5 text-[#FFB744]" aria-hidden />
            {address.split(',').slice(-2, -1)[0]?.trim() ?? 'Long Island'}, NY
          </p>
          <div className="flex items-center gap-3 md:gap-4">
            {design && design.photoUrl && (
              <button
                type="button"
                onClick={() => setShowBefore((v) => !v)}
                aria-pressed={showBefore}
                className="inline-flex items-center gap-1.5 text-[12px] md:text-[13px] font-semibold text-[#F4ECD8]/85 hover:text-[#FFB744] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F] rounded-sm px-2 py-1"
              >
                <Sun className="w-4 h-4" aria-hidden />
                {showBefore ? 'See the lights' : 'See it in daylight'}
              </button>
            )}
            <button
              type="button"
              onClick={scrollToVideo}
              className="inline-flex items-center gap-1.5 text-[12px] md:text-[13px] font-semibold text-[#F4ECD8]/85 hover:text-[#FFB744] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F] rounded-sm px-2 py-1"
            >
              <PlayCircle className="w-4 h-4" aria-hidden />
              Watch walkthrough
            </button>
          </div>
        </div>
      </div>

      {/* Bottom content — headline + price + package selector */}
      <div className="absolute bottom-0 left-0 right-0 pb-safe z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 md:pb-14">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8 items-end">
            {/* Headline + live price */}
            <div className="md:col-span-7">
              <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.20em] uppercase text-[#FFB744] mb-2.5">
                Your design
              </p>
              <h1
                id="portal-snow-hero-heading"
                className="font-display text-[36px] leading-[1.04] md:text-[58px] md:leading-[1.02] font-semibold text-[#F4ECD8] tracking-[-0.02em]"
                style={{ textShadow: '0 2px 28px rgba(0,0,0,0.55)' }}
              >
                Here&apos;s your home,{' '}
                <span className="italic text-[#FFD07A]">{firstName}</span>.
              </h1>
              <div className="mt-5 flex items-baseline gap-3 flex-wrap">
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
            </div>

            {/* Package selector */}
            <div className="md:col-span-5">
              <p className="text-[10px] md:text-[11px] font-semibold tracking-[0.22em] uppercase text-[#F4ECD8]/70 mb-2.5">
                Tap to re-illuminate
              </p>
              <div
                role="radiogroup"
                aria-label="Choose your lighting package"
                className="grid grid-cols-2 gap-2 md:gap-2.5"
              >
                {packages.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={packageId === p.id}
                    onClick={() => selectPackage(p.id)}
                    data-active={packageId === p.id}
                    className="portal-snow-pack-tab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]"
                  >
                    <span className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.20em] uppercase text-[#FFB744]">
                      {p.id === 'D' ? 'Custom' : `Tier ${p.id}`}
                      {p.recommended && (
                        <span className="text-[9px] tracking-[0.14em] text-[#FFD07A]/90 normal-case">
                          · most popular
                        </span>
                      )}
                    </span>
                    <span className="font-display text-[17px] md:text-[18px] font-semibold text-[#F4ECD8] leading-[1.15] mt-0.5">
                      {p.name}
                    </span>
                    <span className="portal-snow-price text-[14px] md:text-[15px] font-semibold text-[#F4ECD8]/85 mt-1">
                      {p.id === 'D' && packageId === 'D'
                        ? formatUsd(currentTotal)
                        : p.id === 'D'
                          ? 'You pick'
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
