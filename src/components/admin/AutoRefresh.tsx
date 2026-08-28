'use client';

// Re-fetches the server component's data on an interval (router.refresh, not a
// full reload). The fleet page mounts this on the TODAY view so the positions,
// signal states, and the at-place timer track the 2-minute poller instead of
// freezing at page-load time — a quiet device would otherwise keep "counting"
// on screen forever (staff lens finding, PR #1040).

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
