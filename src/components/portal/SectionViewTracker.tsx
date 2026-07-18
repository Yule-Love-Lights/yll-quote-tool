'use client';

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/posthog';
import type { ServiceType } from '@/lib/serviceType';
import { useSelectionOptional } from './SelectionContext';

// PostHog Wave 4 — generalizes PackagesViewTracker's (v1) one-shot
// IntersectionObserver pattern into a single reusable tracker for any
// below-the-fold portal section. Renders the same invisible 1px sentinel
// instead of wrapping the section, so it never affects layout, and fires
// ONE `section_viewed` event per page load the first time the sentinel
// scrolls into view (or is already on-screen at mount) — the `section` prop
// names which one, so there's never a per-section event name. Guards for
// missing IntersectionObserver (older/embedded webviews) by simply never
// firing — fail-open, matches the rest of the analytics wrapper.
// quoteId/serviceType come from SelectionContext so every mount site is a
// single-line JSX tag with no props to thread through.
//
// PackagesViewTracker itself is untouched — its `package_viewed` event name
// is load-bearing — this is a separate, new component.

/** Pure `section_viewed` properties builder, extracted for unit coverage
 * (no component-render test infra exists in this repo — see
 * StickyBottomBar.test.ts's buildApprovePayload for the same pattern). */
export function buildSectionViewedProperties(
  quoteId: string | undefined,
  serviceType: ServiceType | undefined,
  section: string,
): { quote_id: string | undefined; service_type: ServiceType | undefined; section: string } {
  return { quote_id: quoteId, service_type: serviceType, section };
}

/** Pure one-shot latch check — mirrors the IntersectionObserver callback's
 * guard (never fire twice; only fire while intersecting), extracted for unit
 * coverage. */
export function shouldFireSectionView(alreadyFired: boolean, isIntersecting: boolean): boolean {
  return !alreadyFired && isIntersecting;
}

export function SectionViewTracker({ section }: { section: string }) {
  // Null-safe: the refer page mounts Gallery (and this tracker) with no
  // SelectionProvider — quote_id/service_type just report undefined there
  // (buildSectionViewedProperties already types both as optional).
  const sel = useSelectionOptional();
  const quoteId = sel?.quoteId;
  const serviceType = sel?.serviceType;
  const ref = useRef<HTMLDivElement>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const isIntersecting = entries.some((e) => e.isIntersecting);
      if (!shouldFireSectionView(firedRef.current, isIntersecting)) return;
      firedRef.current = true;
      track('section_viewed', buildSectionViewedProperties(quoteId, serviceType, section));
      io.disconnect();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [quoteId, serviceType, section]);

  return <div ref={ref} aria-hidden className="h-px w-px" />;
}
