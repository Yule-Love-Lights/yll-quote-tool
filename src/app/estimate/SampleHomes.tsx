'use client';

// Customer self-serve estimate — "sample homes" gallery (ledger self-serve, S48).
//
// The 5 Long Island style homes, shown on the ADDRESS screen and kept up while we
// look up the customer's house, so there's something to look at during the wait
// (the Pink's-Window-Washing-style "here's what we do" moment). A browsable,
// auto-advancing carousel of finished (lit) homes.
//
// Assets: drop the 5 images in public/estimate-samples/ as home-1.jpg … home-5.jpg
// (see the README there). Until they exist this renders NOTHING — each <img> that
// fails to load is dropped, and with zero loaded images the whole strip hides — so
// there's no broken-image placeholder before the real assets land.

import { useEffect, useState } from 'react';

// The 5 sample homes. Swap/extend the list as the curated set changes; a missing
// file just drops out (onError below), so a shorter set degrades cleanly.
const SAMPLE_HOMES: { src: string; alt: string }[] = [
  { src: '/estimate-samples/home-1.jpg', alt: 'A Long Island home lit by Yule Love Lights' },
  { src: '/estimate-samples/home-2.jpg', alt: 'A Long Island home lit by Yule Love Lights' },
  { src: '/estimate-samples/home-3.jpg', alt: 'A Long Island home lit by Yule Love Lights' },
  { src: '/estimate-samples/home-4.jpg', alt: 'A Long Island home lit by Yule Love Lights' },
  { src: '/estimate-samples/home-5.jpg', alt: 'A Long Island home lit by Yule Love Lights' },
];

const AUTO_ADVANCE_MS = 3500;

export function SampleHomes() {
  // Only images that actually load are shown, so nothing renders until the real
  // assets are dropped in (see the file header).
  const [okIdx, setOkIdx] = useState<number[]>([]);
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);

  const homes = okIdx.map((i) => SAMPLE_HOMES[i]);

  // Auto-advance while more than one home is loaded and the user isn't interacting.
  useEffect(() => {
    if (paused || homes.length < 2) return;
    const t = setInterval(() => setCurrent((c) => (c + 1) % homes.length), AUTO_ADVANCE_MS);
    return () => clearInterval(t);
  }, [paused, homes.length]);

  // `current` stays in range on its own: images only ever load IN (okIdx grows,
  // never shrinks), so homes.length is monotonically increasing and every index
  // set by the auto-advance (mod length) or a dot click (i < length) stays valid.
  const markOk = (i: number) =>
    setOkIdx((prev) => (prev.includes(i) ? prev : [...prev, i].sort((a, b) => a - b)));
  const markFail = (i: number) => setFailed((prev) => new Set(prev).add(i));

  // Nothing loaded yet AND everything we tried has failed → render nothing.
  if (homes.length === 0 && failed.size >= SAMPLE_HOMES.length) return null;

  return (
    <section
      className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Off-screen load probes — decide which homes are showable. */}
      <div aria-hidden className="hidden">
        {SAMPLE_HOMES.map((h, i) =>
          failed.has(i) ? null : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={h.src} src={h.src} alt="" onLoad={() => markOk(i)} onError={() => markFail(i)} />
          ),
        )}
      </div>

      {homes.length > 0 && (
        <>
          <p className="mb-2 text-center text-sm font-medium text-slate-700">Homes we&apos;ve lit up on Long Island</p>
          <div className="relative overflow-hidden rounded-xl bg-slate-100">
            <div className="relative aspect-[4/3] w-full">
              {homes.map((h, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={h.src}
                  src={h.src}
                  alt={h.alt}
                  className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${i === current ? 'opacity-100' : 'opacity-0'}`}
                />
              ))}
            </div>
          </div>
          {homes.length > 1 && (
            <div className="mt-3 flex items-center justify-center gap-2">
              {homes.map((h, i) => (
                <button
                  key={h.src}
                  type="button"
                  aria-label={`Show sample home ${i + 1}`}
                  onClick={() => setCurrent(i)}
                  className={`h-2 rounded-full transition-all ${i === current ? 'w-5 bg-amber-600' : 'w-2 bg-slate-300 hover:bg-slate-400'}`}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
