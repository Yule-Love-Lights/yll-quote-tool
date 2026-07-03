'use client';

// Shared focus management for the portal's inline dialogs (audit W4-015).
// SignModal (StickyBottomBar), DepositCheckout, and QuoteResponseModal each
// render `role="dialog" aria-modal="true"` but previously never moved focus
// into the dialog on open, trapped Tab within it, or restored focus on close
// — a barrier for keyboard/AT users on the highest-stakes flow (approve +
// pay). Attach the returned ref to the dialog's outer container (the
// `role="dialog"` element).
//
// Behavior:
//   - On mount: focus the first focusable element inside the dialog (falling
//     back to the container itself, made programmatically focusable).
//   - While mounted: Tab/Shift+Tab wraps within the dialog instead of
//     escaping to the page behind it.
//   - On unmount: restore focus to whatever was focused before the dialog
//     opened (the trigger button), matching the pattern every caller here
//     already uses (open a modal from a button click).

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    // Move focus into the dialog. Prefer its first focusable control; fall
    // back to the container itself so a screen reader's cursor still lands
    // inside the dialog even if it has no natively-focusable children yet.
    const first = focusables()[0];
    if (first) {
      first.focus();
    } else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    container.addEventListener('keydown', onKeyDown);

    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore focus to the trigger that opened this dialog.
      previouslyFocused?.focus?.();
    };
  }, []);

  return containerRef;
}
