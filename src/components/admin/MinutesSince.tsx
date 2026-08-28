'use client';

// A minutes-ago counter that ticks once a minute, for "At Depot · 43 min" on
// the fleet page's live tile (Jason's ask, 2026-08-28). Renders the minutes
// only; the surrounding copy is the server component's.

import { useEffect, useState } from 'react';

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
}

export function MinutesSince({ sinceIso }: { sinceIso: string }) {
  // The initial value comes from useState's initializer; the effect only sets
  // up the once-a-minute tick (a synchronous set inside the effect trips the
  // cascading-renders lint rule, and the initializer makes it redundant).
  const [minutes, setMinutes] = useState(() => minutesSince(sinceIso));

  useEffect(() => {
    const t = setInterval(() => setMinutes(minutesSince(sinceIso)), 60_000);
    return () => clearInterval(t);
  }, [sinceIso]);

  return <>{minutes} min</>;
}
