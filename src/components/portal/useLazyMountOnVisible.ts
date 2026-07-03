'use client';

// #110 W4-023: the IntersectionObserver lazy-mount effect — reveal a heavy
// (Konva) subtree only once its wrapper scrolls near the viewport — was
// copy-pasted near-identically between PhotoGallery and DesignReprise. One
// shared hook now.
//
// IntersectionObserver is the REAL trigger; the timer is only a last-resort
// safety net (broken webview / no IO support) so a card can't stay blank
// forever. setState is deferred via queueMicrotask (project rule:
// react-hooks/set-state-in-effect is an error).

import { useEffect, useRef, useState } from 'react';

export function useLazyMountOnVisible<T extends HTMLElement>(
  rootMargin = '200px',
  safetyMs = 15000,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const reveal = () => {
      if (cancelled) return;
      cancelled = true;
      queueMicrotask(() => setMounted(true));
    };
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) reveal();
        },
        { rootMargin },
      );
      io.observe(el);
    }
    const safety = window.setTimeout(reveal, safetyMs);
    return () => {
      cancelled = true;
      io?.disconnect();
      window.clearTimeout(safety);
    };
  }, [mounted, rootMargin, safetyMs]);

  return [ref, mounted];
}
