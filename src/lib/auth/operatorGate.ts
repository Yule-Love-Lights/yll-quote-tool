// Operator-surface auth gate (PROPOSAL — see docs/audit/AUTH-PROPOSAL.md).
//
// The whole app is operator-only EXCEPT a small, explicit allowlist of
// customer-facing + webhook paths. This module is the single source of truth
// for that boundary; the middleware is a thin wrapper around it. Keeping the
// classification here (pure, no Next/edge APIs) makes it unit-testable — which
// matters because getting the allowlist wrong either locks out customers or
// leaves PII exposed.
//
// Before enabling this in production, verify the PUBLIC allowlist below against
// EVERY customer-reachable route (a missed one returns 401/redirect to a real
// customer). The list was derived 2026-06-27 from the portal flow.

// Customer-triggered quote sub-routes, gated only by the quote UUID (the
// capability token), never by operator auth.
const PUBLIC_QUOTE_SUBROUTES = new Set(['approve', 'pay', 'view']);

// Exact public API paths (webhooks + the login surface).
const PUBLIC_API_EXACT = new Set([
  '/api/login',
  '/api/integrations/valor/webhook', // Valor deposit webhook (HMAC-verified in the route)
  '/api/integrations/homeworks/signed', // home.works signed webhook (shared-secret in the route)
  '/api/inventory/purchase-order/auto-send', // Vercel Cron (CRON_SECRET-guarded, #82 auto-PO)
]);

/**
 * True when `pathname` is reachable WITHOUT operator authentication — the
 * customer portal, its customer-triggered APIs, public webhooks, public image
 * assets, and the login surface. Everything else is operator-only.
 */
export function isPublicPath(pathname: string): boolean {
  // Login surface.
  if (pathname === '/login') return true;

  // Customer portal pages + the public image redirector.
  if (pathname === '/portal' || pathname.startsWith('/portal/')) return true;
  if (pathname.startsWith('/photos/')) return true;

  // Exact public APIs (webhooks + login).
  if (PUBLIC_API_EXACT.has(pathname)) return true;

  // Customer quote sub-routes: /api/quotes/<id>/(approve|pay|view).
  const m = /^\/api\/quotes\/[^/]+\/([^/]+)$/.exec(pathname);
  if (m && PUBLIC_QUOTE_SUBROUTES.has(m[1]!)) return true;

  return false;
}

/**
 * Constant-time-ish string compare (length leak only). Pure JS so it runs on
 * the Edge runtime where node:crypto timingSafeEqual isn't available.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when the request carries a valid operator credential — either the
 * session cookie (set by /api/login) or the legacy x-admin-secret header (so
 * the existing /admin/quotes calls keep working). Fails closed when the server
 * secret is unset.
 */
export function hasValidOperatorAuth(
  credential: { cookie?: string | null; header?: string | null },
  secret: string | undefined,
): boolean {
  if (!secret) return false; // fail closed — no secret configured ⇒ no access
  const provided = credential.header || credential.cookie;
  if (!provided) return false;
  return safeEqual(provided, secret);
}

export const OPERATOR_COOKIE = 'yll_operator';
