'use client';

import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/posthog';
import type { ServiceType } from '@/lib/serviceType';

// #68 — records that the customer opened this quote. Fires a one-shot POST to
// /api/quotes/[id]/view on mount. Using a client useEffect (not a server hit)
// means HTML-only bots / link unfurlers, which don't run JS, don't count as a
// view. The ref guard keeps React strict-mode's double-invoke to a single POST
// per page load (a refresh is a new load = a new open, which is intended).
// Fire-and-forget: a failure must never disrupt the customer's portal.
//
// PostHog v1: the same one-shot fires a `portal_opened` event alongside the
// view POST — track() is a no-op when PostHog isn't configured.
export function QuoteViewTracker({
  quoteId,
  serviceType,
}: {
  quoteId: string;
  serviceType?: ServiceType;
}) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    fetch(`/api/quotes/${encodeURIComponent(quoteId)}/view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      keepalive: true,
    }).catch(() => {
      /* best-effort */
    });
    track('portal_opened', { quote_id: quoteId, service_type: serviceType });
  }, [quoteId, serviceType]);
  return null;
}
