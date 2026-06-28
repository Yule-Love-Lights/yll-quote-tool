// Operator-surface auth gate — the public/operator boundary (ledger #81).
//
// The whole app is operator-only EXCEPT a small, explicit allowlist of
// customer-facing + webhook paths. This module is the single source of truth for
// that boundary; the middleware is a thin wrapper around it. Keeping the
// classification here (pure, no Next/edge APIs) makes it unit-testable — which
// matters because getting the allowlist wrong either locks out customers or
// leaves PII exposed.
//
// Before enabling this in production, verify the PUBLIC allowlist below against
// EVERY customer-reachable route (a missed one returns 401/redirect to a real
// customer). The list was derived from the portal + webhook/cron flows.

// Customer-triggered quote sub-routes (/api/quotes/<id>/<sub>), gated only by the
// quote UUID (the capability token), never by operator auth. The portal fires ALL
// of these: approve/pay/view from the hero + sticky bar, and decline /
// request-changes (QuoteResponseModal) / interested (StickyBottomBar). Note: a
// quote's `send` sub-route is the OPERATOR action and is intentionally NOT here.
const PUBLIC_QUOTE_SUBROUTES = new Set([
  'approve',
  'pay',
  'view',
  'decline',
  'request-changes',
  'interested',
]);

// Exact public API paths (webhooks + crons + the login surface).
const PUBLIC_API_EXACT = new Set([
  '/api/login',
  '/api/integrations/valor/webhook', // Valor deposit webhook (HMAC-verified in the route)
  '/api/integrations/homeworks/signed', // home.works signed webhook (shared-secret in the route)
  '/api/integrations/whatsapp/webhook', // Twilio WhatsApp webhook (signature-verified in the route, #82)
  '/api/integrations/telegram/webhook', // Telegram Bot webhook (secret-token verified in the route, #82 alt channel)
  '/api/inventory/purchase-order/auto-send', // Vercel Cron (CRON_SECRET-guarded, #82 auto-PO)
  '/api/inventory/low-stock-alert', // Vercel Cron (CRON_SECRET-guarded, #82 low-stock alarm)
]);

/**
 * True when `pathname` is reachable WITHOUT operator authentication — the
 * customer portal, its customer-triggered APIs, public webhooks + crons, public
 * image assets, and the login surface. Everything else is operator-only.
 */
export function isPublicPath(pathname: string): boolean {
  // Normalize a single trailing slash before classifying. Next strips these when
  // trailingSlash is false (the default), but a third-party webhook (Twilio /
  // Valor / Zapier) configured WITH one must not 401 once the gate is live — so
  // be defensive here rather than depend on that normalization staying off.
  const path =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  // Login surface.
  if (path === '/login') return true;

  // Customer portal pages + the public image redirector.
  if (path === '/portal' || path.startsWith('/portal/')) return true;
  if (path.startsWith('/photos/')) return true;

  // Exact public APIs (webhooks + crons + login).
  if (PUBLIC_API_EXACT.has(path)) return true;

  // Customer quote sub-routes: /api/quotes/<id>/(approve|pay|view|decline|request-changes|interested).
  const m = /^\/api\/quotes\/[^/]+\/([^/]+)$/.exec(path);
  if (m && PUBLIC_QUOTE_SUBROUTES.has(m[1]!)) return true;

  return false;
}
