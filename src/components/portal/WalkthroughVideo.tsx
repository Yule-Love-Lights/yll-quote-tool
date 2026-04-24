'use client';

// Portal v1 — WalkthroughVideo. A personal video from Naldo sits
// directly below the Hero and walks the customer through their quote.
// Big conversion lever: hearing the designer's voice explain the
// design in 60-90s collapses objections faster than any static copy.
//
// Performance: we never load the player on mount. We show a poster
// image + custom play button. On tap, we swap in the real player.
// This keeps LCP + TBT low — the YouTube iframe alone is ~540KB.
//
// Hosting: supports both YouTube (youtube-nocookie domain, no related
// videos, no branding) and direct MP4 URLs. Swap `kind` on the quote.

import { useState } from 'react';
import { Play, Clock } from 'lucide-react';
import type { PortalVideo } from './types';

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
  // youtube-nocookie + modestbranding + rel=0 + no related videos at end
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
      aria-labelledby="portal-walkthrough-heading"
      className="relative w-full bg-[#FAF6EF]"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-14 md:py-20">
        <div className="max-w-2xl mb-8 md:mb-10">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            Walkthrough from {leader}
          </p>
          <h2
            id="portal-walkthrough-heading"
            className="font-display text-[28px] md:text-[40px] leading-[1.1] font-semibold text-[#1F1B16] tracking-[-0.01em]"
          >
            {label}
          </h2>
          <p className="mt-3 text-[16px] md:text-[17px] text-[#3A3229] leading-[1.6]">
            A quick video from {leader} explaining exactly what we designed for your
            home and how the whole process works.
          </p>
        </div>

        <div className="relative rounded-2xl overflow-hidden bg-[#1F1B16] shadow-[0_2px_4px_rgba(31,27,22,0.08),0_20px_48px_-12px_rgba(31,27,22,0.25)] aspect-video">
          {!activated ? (
            <button
              type="button"
              onClick={() => setActivated(true)}
              aria-label={`Play walkthrough video from ${leader}`}
              className="group absolute inset-0 w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF]"
            >
              {poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={poster}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-cover"
                  loading="lazy"
                />
              )}
              {/* Dark vignette over the poster so the play button pops */}
              <div
                aria-hidden
                className="absolute inset-0 bg-gradient-to-t from-[#1F1B16]/70 via-[#1F1B16]/20 to-transparent"
              />

              {/* Play button */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center w-20 h-20 md:w-24 md:h-24 rounded-full bg-[#C89B3C] text-[#1F1B16] shadow-[0_8px_32px_-4px_rgba(200,155,60,0.7),0_0_0_8px_rgba(250,246,239,0.15)] transition-transform duration-300 group-hover:scale-105 group-active:scale-95"
                >
                  <Play className="w-8 h-8 md:w-10 md:h-10 ml-1 fill-[#1F1B16]" aria-hidden />
                </span>
              </div>

              {/* Duration badge */}
              {typeof video.durationSec === 'number' && (
                <span
                  aria-hidden
                  className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#1F1B16]/80 backdrop-blur-sm text-[#FAF6EF] text-[12px] font-semibold tabular-nums"
                >
                  <Clock className="w-3.5 h-3.5" aria-hidden />
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
              className="absolute inset-0 w-full h-full object-cover bg-[#1F1B16]"
            >
              <track kind="captions" />
            </video>
          )}
        </div>
      </div>
    </section>
  );
}
