// src/lib/integrations/bouncieOAuthState.ts
// The small shared pieces of the Bouncie OAuth round trip (ledger row 403).
//
// Split out so the start route and the callback cannot drift apart on the cookie
// name or on how the base URL is worked out — a mismatch in either would present
// as "the grant silently never completes", which is exactly the kind of failure
// nobody diagnoses quickly.

import { safeEqual } from '@/lib/security';

/** Where the one-time `state` lives between starting the flow and returning. */
export const OAUTH_STATE_COOKIE = 'bouncie_oauth_state';

/**
 * The app's own base URL.
 *
 * Uses `PORTAL_BASE_URL` with the same fallback as `telegramNotify.ts`, rather
 * than the request's own origin. Building a redirect from the incoming request
 * means a forged Host or forwarded header can steer where the browser lands
 * afterwards, and this repo already had a single agreed way to answer "what is
 * our address" (S68 technical and security lenses).
 */
export function portalBaseUrl(): string {
  return (process.env.PORTAL_BASE_URL || 'https://quote.yulelovelights.com').replace(/\/+$/, '');
}

/**
 * True when the `state` returned by the provider matches the one we issued.
 *
 * Constant-time, and fails closed on either side being absent: a callback with
 * no cookie is either a stale flow or a forged one, and neither should be
 * allowed to store a fleet-wide credential.
 */
export function stateMatches(fromQuery: string | null | undefined, fromCookie: string | null | undefined): boolean {
  if (!fromQuery || !fromCookie) return false;
  return safeEqual(fromQuery, fromCookie);
}
