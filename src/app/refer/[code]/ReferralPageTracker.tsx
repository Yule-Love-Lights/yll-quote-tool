'use client';

// Referral program (#41) — one-shot PostHog view event for the landing page.
// Mirrors src/components/portal/QuoteViewTracker.tsx's mount-fires-once pattern.
//
// #41 adversarial-review LOW fix: attribute by `code` alone — the internal
// referrer customer id has no reason to leave the server (analysis can
// always resolve code -> referrer server-side; getReferralByCode already
// does that lookup on every page load).

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/posthog';

export function ReferralPageTracker({ code }: { code: string }) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    track('referral_link_clicked', { code });
  }, [code]);
  return null;
}
