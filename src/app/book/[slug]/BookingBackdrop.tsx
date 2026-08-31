'use client';

// The booking page's photo backdrop: real completed installs, crossfading
// slowly behind the page.
//
// Layout is deliberately different on a phone. Full bleed behind a tall booking
// widget reads as a dark smear, so below the md breakpoint the photo is a fixed
// band across the top and the booking card sits underneath it. From md up it is
// a fixed full-screen backdrop. One instance handles both, so the browser is
// never asked to load the same photos twice.
//
// Every photo is mounted at once and only opacity changes, which is what makes
// the crossfade a fade rather than a flash of empty space while the next file
// downloads.

import Image from 'next/image';
import { useEffect, useState } from 'react';
import type { BackdropPhoto } from './backdropPhotos';

const FADE_INTERVAL_MS = 7000;

export function BookingBackdrop({ photos }: { photos: BackdropPhoto[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (photos.length < 2) return;
    // Someone who has asked their machine to stop animating things gets the
    // first photo, held. Read at mount rather than in a media query so the
    // timer is never started at all, instead of running invisibly.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % photos.length),
      FADE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [photos.length]);

  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 h-64 overflow-hidden md:fixed md:inset-0 md:h-full"
    >
      {photos.map((photo, i) => (
        <Image
          key={photo.id}
          src={photo.src}
          alt=""
          fill
          // One photo wide on every screen, so the browser should size for the
          // full viewport width rather than the default srcset guess.
          sizes="100vw"
          priority={i === 0}
          className={`object-cover transition-opacity duration-1000 ease-in-out ${
            i === index ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ))}
      {/* Scrim. Heavier at the bottom on a phone so the band blends into the
          page behind the card; a flatter, overall darkening on desktop, where
          the card sits in the middle of the picture. */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#060B0F]/30 via-[#060B0F]/75 to-[#060B0F] md:from-[#060B0F]/70 md:via-[#060B0F]/75 md:to-[#060B0F]/85" />
    </div>
  );
}
