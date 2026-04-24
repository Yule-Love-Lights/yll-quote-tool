'use client';

// Portal v4 — Section III: Walkthrough from your concierge.
// Framed like a letter from Naldo, not a "watch this video" CTA. Serif
// intro paragraph with drop cap, then a cream-framed video player.
// Same lazy-load pattern as other portals — poster + button on mount,
// iframe/video swaps in only on click (LCP-safe).

import { useState } from 'react';
import { Play, Clock } from 'lucide-react';
import type { PortalVideo } from '../types';

export type ConciergeWalkthroughProps = {
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

export function ConciergeWalkthrough({ video }: ConciergeWalkthroughProps) {
  const [activated, setActivated] = useState(false);

  const poster =
    video.poster ??
    (video.kind === 'youtube' ? youtubePoster(video.src) : undefined);

  const label = video.title ?? 'A note from your concierge';
  const leader = video.leaderName ?? 'Naldo';

  return (
    <section
      id="concierge-walkthrough"
      aria-labelledby="concierge-walkthrough-heading"
      className="portal-concierge-section scroll-mt-4"
    >
      <div className="max-w-4xl mx-auto px-6 md:px-10">
        <div className="mb-10 md:mb-14 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">III</p>
          <p className="portal-concierge-eyebrow mb-4">A letter from {leader}</p>
          <h2
            id="concierge-walkthrough-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            {label}
          </h2>
        </div>

        <div className="max-w-2xl mx-auto mb-10 md:mb-12">
          <p className="portal-concierge-dropcap font-display-italic text-[19px] md:text-[22px] leading-[1.65] text-[var(--yc-ink-soft)] text-left">
            Before you decide, I&apos;d like to walk you through what I designed for your home —
            which strands go where, which accents I chose, and how the install week will unfold.
            A few minutes, nothing more. <span className="not-italic">— {leader}</span>
          </p>
        </div>

        <div className="relative rounded-sm overflow-hidden bg-[var(--yc-green-deep)] border border-[var(--yc-rule-soft)] shadow-[var(--yc-shadow-card-hi)] aspect-video">
          {!activated ? (
            <button
              type="button"
              onClick={() => setActivated(true)}
              aria-label={`Play walkthrough from ${leader}`}
              className="group absolute inset-0 w-full h-full cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--yc-red-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--yc-cream)]"
            >
              {poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={poster}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-cover transition-[opacity,transform] duration-500 opacity-90 group-hover:opacity-100 group-hover:scale-[1.015]"
                  loading="lazy"
                />
              )}
              <div
                aria-hidden
                className="absolute inset-0 bg-gradient-to-t from-[rgba(10,42,20,0.85)] via-[rgba(10,42,20,0.35)] to-[rgba(10,42,20,0.55)]"
              />

              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center w-20 h-20 md:w-24 md:h-24 rounded-full bg-[var(--yc-red-bright)] text-[var(--yc-cream)] transition-[transform,background-color] duration-300 group-hover:scale-105 group-hover:bg-[var(--yc-red-brighter)] group-active:scale-95 shadow-[0_0_0_8px_rgba(200,49,61,0.18),0_20px_40px_-10px_rgba(139,31,43,0.45)]"
                >
                  <Play className="w-8 h-8 md:w-9 md:h-9 ml-1 fill-[var(--yc-cream)]" aria-hidden />
                </span>
              </div>

              {typeof video.durationSec === 'number' && (
                <span
                  aria-hidden
                  className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-[rgba(10,42,20,0.82)] backdrop-blur-sm border border-[rgba(244,236,216,0.2)] text-[var(--yc-cream-on-green)] text-[12px] font-semibold tabular-nums"
                >
                  <Clock className="w-3.5 h-3.5 text-[var(--yc-brass-bright)]" aria-hidden />
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
              className="absolute inset-0 w-full h-full object-cover bg-[var(--yc-green-deep)]"
            >
              <track kind="captions" />
            </video>
          )}
        </div>
      </div>
    </section>
  );
}
