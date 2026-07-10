'use client';

// App-wide client providers. Currently just PostHog init (analytics v1) —
// fires once on mount and is a no-op when NEXT_PUBLIC_POSTHOG_KEY isn't set.

import { useEffect } from 'react';
import { initPostHog } from '@/lib/analytics/posthog';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initPostHog();
  }, []);
  return <>{children}</>;
}
