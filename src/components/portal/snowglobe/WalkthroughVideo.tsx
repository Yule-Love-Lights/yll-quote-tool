'use client';

// Portal v6 — WalkthroughVideo. Snowglobe-styled variant: slightly
// narrower to feel like a product-page feature row, uses the v6 amber
// accent (#FFB744) instead of v2's gold (#E8B862). Keeps the id
// "portal-snow-walkthrough" as a stable section anchor for deep-linking
// (the in-hero "Watch walkthrough" scroll button was removed in #61).

import { useState } from 'react';
import { Play, Clock } from 'lucide-react';
import type { PortalVideo } from '../types';

export type WalkthroughVideoProps = {
  video: PortalVideo;
};

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function youtubePoster(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function youtubeEmbedSrc(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0&modestbranding=1&color=white`;
}

export function WalkthroughVideo({ video }: WalkthroughVideoProps) {
  const [activated, setActivated] = useState(false);

  const poster =
    video.poster ??
    (video.kind === 'youtube' ? youtubePoster(video.src) : undefined);

  const label = video.title ?? 'Your personal walkthrough';
  const leader = video.leaderName ?? 'Naldo';

  return (
    <section
      id="portal-snow-walkthrough"
      aria-labelledby="portal-snow-walkthrough-heading"
      className="relative w-full bg-[#060B0F] scroll-mt-4"
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-10 md:mb-12">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.22em] uppercase text-[#FFB744] mb-3">
            Walkthrough from {leader}
          </p>
          <h2
            id="portal-snow-walkthrough-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.08] font-semibold text-[#F4ECD8] tracking-[-0.015em]"
          >
            {label}
          </h2>
          <p className="mt-4 text-[16px] md:text-[17px] text-[#A89F87] leading-[1.65]">
            {leader} recorded a quick video explaining exactly what was designed for your
            home and how the whole install process works. Watch before you approve.
          </p>
        </div>

        <div className="relative rounded-[20px] overflow-hidden bg-[#050908] border border-[#1F2A23] shadow-[0_2px_6px_rgba(0,0,0,0.6),0_40px_80px_-24px_rgba(0,0,0,0.85)] aspect-video">
          {!activated ? (
            <button
              type="button"
              onClick={() => setActivated(true)}
              aria-label={`Play walkthrough video from ${leader}`}
              className="group absolute inset-0 w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]"
            >
              {poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={poster}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-cover opacity-80 transition-[opacity,transform] duration-500 group-hover:opacity-100 group-hover:scale-[1.015]"
                  loading="lazy"
                />
              )}
              <div
                aria-hidden
                className="absolute inset-0 bg-gradient-to-t from-[#050908]/90 via-[#050908]/40 to-[#050908]/55"
              />
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background:
                    'radial-gradient(ellipse 55% 45% at 50% 50%, rgba(255,183,68,0.28) 0%, transparent 55%)',
                  mixBlendMode: 'screen',
                }}
              />

              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center w-[88px] h-[88px] md:w-28 md:h-28 rounded-full bg-[#FFB744] text-[#060B0F] shadow-[0_0_56px_rgba(255,183,68,0.65),0_0_120px_rgba(255,183,68,0.28),0_0_0_12px_rgba(255,183,68,0.10)] transition-transform duration-300 group-hover:scale-[1.06] group-active:scale-95"
                >
                  <Play className="w-9 h-9 md:w-11 md:h-11 ml-1 fill-[#060B0F]" aria-hidden />
                </span>
              </div>

              {typeof video.durationSec === 'number' && (
                <span
                  aria-hidden
                  className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#060B0F]/85 backdrop-blur-sm border border-[#1F2A23] text-[#E0D7C1] text-[12px] font-semibold tabular-nums"
                >
                  <Clock className="w-3.5 h-3.5 text-[#FFB744]" aria-hidden />
                  {formatDuration(video.durationSec)}
                </span>
              )}
            </button>
          ) : video.kind === 'youtube' ? (
            <iframe
              src={youtubeEmbedSrc(video.src)}
              title={label}
              loading="eager"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
              className="absolute inset-0 w-full h-full"
            />
          ) : (
            <video
              src={video.src}
              poster={poster}
              autoPlay
              controls
              playsInline
              className="absolute inset-0 w-full h-full object-cover bg-[#050908]"
            >
              <track kind="captions" />
            </video>
          )}
        </div>
      </div>
    </section>
  );
}
