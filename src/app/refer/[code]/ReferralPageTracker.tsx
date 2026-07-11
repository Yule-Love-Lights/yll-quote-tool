'use client';

// Referral program (#41) — one-shot PostHog view event for the landing page.
// Mirrors src/components/portal/QuoteViewTracker.tsx's mount-fires-once pattern.

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/posthog';

export function ReferralPageTracker({
  referrerCustomerId,
  code,
}: {
  referrerCustomerId: string;
  code: string;
}) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    track('referral_link_clicked', { referrer_customer_id: referrerCustomerId, code });
  }, [referrerCustomerId, code]);
  return null;
}
