'use client';

// Portal v2 DARK — WalkthroughVideo. Same lazy-load player pattern as
// v1, restyled for the dark theme: warm gold play button with a real
// bulb-glow halo, cream text, cinematic framing.

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
      aria-labelledby="portal-dark-walkthrough-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-10 md:mb-12">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Walkthrough from {leader}
          </p>
          <h2
            id="portal-dark-walkthrough-heading"
            className="font-display text-[28px] md:text-[42px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            {label}
          </h2>
          <p className="mt-4 text-[16px] md:text-[17px] text-[#A89F87] leading-[1.65]">
            A quick video from {leader} explaining exactly what we designed for your
            home and how the whole process works.
          </p>
        </div>

        <div className="relative rounded-2xl overflow-hidden bg-[#050908] border border-[#243029] shadow-[0_2px_6px_rgba(0,0,0,0.55),0_24px_56px_-12px_rgba(0,0,0,0.75)] aspect-video">
          {!activated ? (
            <button
              type="button"
              onClick={() => setActivated(true)}
              aria-label={`Play walkthrough video from ${leader}`}
              className="group absolute inset-0 w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F]"
            >
              {poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={poster}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-cover opacity-85 transition-opacity duration-300 group-hover:opacity-100"
                  loading="lazy"
                />
              )}
              {/* Dark vignette + warm bloom to match portal lighting */}
              <div
                aria-hidden
                className="absolute inset-0 bg-gradient-to-t from-[#050908]/85 via-[#050908]/30 to-[#050908]/50"
              />
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background:
                    'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(232,184,98,0.22) 0%, transparent 55%)',
                  mixBlendMode: 'screen',
                }}
              />

              {/* Play button with bulb halo */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center w-20 h-20 md:w-24 md:h-24 rounded-full bg-[#E8B862] text-[#0B140F] shadow-[0_0_48px_rgba(232,184,98,0.55),0_0_100px_rgba(232,184,98,0.25),0_0_0_10px_rgba(232,184,98,0.12)] transition-transform duration-300 group-hover:scale-105 group-active:scale-95"
                >
                  <Play className="w-8 h-8 md:w-10 md:h-10 ml-1 fill-[#0B140F]" aria-hidden />
                </span>
              </div>

              {/* Duration badge */}
              {typeof video.durationSec === 'number' && (
                <span
                  aria-hidden
                  className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#0B140F]/85 backdrop-blur-sm border border-[#243029] text-[#E0D7C1] text-[12px] font-semibold tabular-nums"
                >
                  <Clock className="w-3.5 h-3.5 text-[#E8B862]" aria-hidden />
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
