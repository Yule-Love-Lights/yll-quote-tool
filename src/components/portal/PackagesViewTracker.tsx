'use client';

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/posthog';

// PostHog v1 — fires `package_viewed` once the packages/tiers section first
// scrolls into view (or is already on-screen at mount, e.g. the hero is above
// the fold on desktop). Renders an invisible 1px sentinel instead of wrapping
// the section, so it never affects layout. Guards for missing
// IntersectionObserver (older/embedded webviews) by simply never firing —
// fail-open, matches the rest of the analytics wrapper.
export function PackagesViewTracker({ quoteId }: { quoteId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (firedRef.current) return;
      if (entries.some((e) => e.isIntersecting)) {
        firedRef.current = true;
        track('package_viewed', { quote_id: quoteId });
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [quoteId]);

  return <div ref={ref} aria-hidden className="h-px w-px" />;
}
