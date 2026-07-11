'use client';

// Referral landing page (#41 adversarial-review LOW fix) — the hero photo can
// be a customer's own design photo (a private-bucket URL that can 404 if the
// image was ever moved or removed); onError swaps to the completed-work
// gallery fallback so the page never shows a broken image. A no-op when
// there's no fallback to swap to (the gallery-fallback branch is already the
// fallback — page.tsx only passes fallbackSrc on the design-photo branch).

import { useState } from 'react';

export function ReferralHeroImage({
  src,
  alt,
  fallbackSrc,
}: {
  src: string;
  alt: string;
  fallbackSrc?: string;
}) {
  const [current, setCurrent] = useState(src);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={current}
      alt={alt}
      className="absolute inset-0 w-full h-full object-cover"
      onError={() => {
        if (fallbackSrc && current !== fallbackSrc) setCurrent(fallbackSrc);
      }}
    />
  );
}
