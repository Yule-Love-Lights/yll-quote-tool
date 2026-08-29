'use client';

// A minutes-ago counter that ticks once a minute, for "At Depot · 43 min" on
// the fleet page's live tile (Jason's ask, 2026-08-28). Renders the minutes
// only; the surrounding copy is the server component's.

import { useSyncExternalStore } from 'react';

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
}

// Ticks the subscriber once right after mount (so the real value appears
// almost immediately) and then once a minute after that.
function subscribe(onChange: () => void): () => void {
  const immediate = setTimeout(onChange, 0);
  const interval = setInterval(onChange, 60_000);
  return () => {
    clearTimeout(immediate);
    clearInterval(interval);
  };
}

export function MinutesSince({ sinceIso }: { sinceIso: string }) {
  // The old code computed the initial value in useState's initializer, which
  // Next runs once on the server (at the request's wall-clock time) and again
  // on the client during hydration (at the browser's wall-clock time) — a few
  // seconds apart is enough to cross a minute boundary and render different
  // text on each side. That threw a real hydration mismatch in prod (PostHog
  // $exception, React error #418, /admin/fleet, 2026-08-28).
  //
  // useSyncExternalStore is the built-in fix for exactly this: getServerSnapshot
  // supplies the value used for BOTH the server render and the client's first
  // (hydrating) render, so the two can't disagree. Once mounted, subscribe's
  // immediate tick swaps in the real client-computed value, then it re-ticks
  // once a minute — no setState-in-effect, so this doesn't trip the
  // cascading-renders lint rule the old code's comment referenced either.
  const minutes = useSyncExternalStore(
    subscribe,
    () => minutesSince(sinceIso),
    () => null,
  );

  if (minutes === null) return null;
  return <>{minutes} min</>;
}
