'use client';

import { useEffect, useRef } from 'react';

// #68 — records that the customer opened this quote. Fires a one-shot POST to
// /api/quotes/[id]/view on mount. Using a client useEffect (not a server hit)
// means HTML-only bots / link unfurlers, which don't run JS, don't count as a
// view. The ref guard keeps React strict-mode's double-invoke to a single POST
// per page load (a refresh is a new load = a new open, which is intended).
// Fire-and-forget: a failure must never disrupt the customer's portal.
export function QuoteViewTracker({ quoteId }: { quoteId: string }) {
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
  }, [quoteId]);
  return null;
}
