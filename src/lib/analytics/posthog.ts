// PostHog analytics v1 — thin client-side wrapper (ledger: posthog-v1).
//
// Fail-open by contract: every export here is a safe no-op when
// NEXT_PUBLIC_POSTHOG_KEY is unset, PostHog is blocked (ad-blocker/CSP), or the
// SDK throws — the app must behave identically to today whether or not
// PostHog is configured. Nothing here may block, throw, or change control
// flow for a caller.
//
// Session replay is fully masked (every text node + every input), since the
// portal/quote UI shows customer names, addresses, and prices on screen and
// there's no safe subset to leave unmasked. Exception capture is on so JS
// errors surface without any extra wiring. isFlagEnabled is the v1
// feature-flag helper — nothing in the app is gated behind it yet.

import posthog from 'posthog-js';

let initialized = false;

/**
 * Initialize PostHog once per page load. Safe to call unconditionally (e.g.
 * from a client component's mount effect) — no-ops and returns false when
 * NEXT_PUBLIC_POSTHOG_KEY is empty/unset, when called outside the browser
 * (SSR), or if posthog-js itself throws during init.
 */
export function initPostHog(): boolean {
  if (initialized) return true;
  if (typeof window === 'undefined') return false;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (!key) return false;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';
  try {
    posthog.init(key, {
      api_host: host,
      // Opt into the SDK's current recommended defaults snapshot (pinned to
      // the posthog-js version in package.json at the time this was written —
      // bump this string when the package is upgraded and a newer snapshot
      // exists).
      defaults: '2026-06-25',
      // Auto-installs window.onerror / unhandledrejection capture.
      capture_exceptions: true,
      // Full masking: every text node and every input is replaced in the
      // recording, regardless of per-element ph-mask classes — this app
      // never wants an unmasked customer name/address/price on tape.
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*',
      },
    });
    initialized = true;
    // Staff devices carry the yll_staff_device cookie (set by MarkStaffDevice on
    // every operator page). Register it as a super property so PostHog's
    // internal-user filter can exclude office traffic from customer metrics.
    try {
      if (typeof document !== 'undefined' && /(?:^|;\s*)yll_staff_device=/.test(document.cookie)) {
        posthog.register({ staff_device: true });
      }
    } catch {
      // best-effort — a failed cookie read or register must never break init
    }
    return true;
  } catch {
    return false; // fail open — a blocked/broken script must never break the app
  }
}

/** Safe event capture. Never throws; no-ops when PostHog can't initialize. */
export function track(event: string, properties?: Record<string, unknown>): void {
  // Lazy init: React flushes CHILD effects before parent effects, so a deep
  // component's mount event (e.g. QuoteViewTracker's portal_opened) runs
  // before the root <Providers> effect has called initPostHog(). Without
  // this, every event fired during the initial render commit is dropped.
  if (!initialized && !initPostHog()) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // best-effort — analytics must never disrupt the app
  }
}

/**
 * v1 feature-flag helper. Returns false when uninitialized or on error.
 * Nothing in the app gates on this yet — it exists for future use.
 */
export function isFlagEnabled(flag: string): boolean {
  // Same lazy init as track() — safe for callers that run before <Providers>.
  if (!initialized && !initPostHog()) return false;
  try {
    return posthog.isFeatureEnabled(flag) === true;
  } catch {
    return false;
  }
}
