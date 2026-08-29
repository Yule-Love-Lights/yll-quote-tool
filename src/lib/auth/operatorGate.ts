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
// 'simulate-deposit' (#81 W6-008) is the anonymous portal's TEST-quote deposit
// simulator (DepositCheckout.tsx) — amend-consent records a signature only on
// the latest pending booked amendment; the route validates the quote and compare-
// and-swaps the snapshot. simulate-deposit itself re-verifies is_test===true
// before doing anything, so allowlisting it here only ever affects test rows.
// 'amend-decline' (ledger #83 follow-up) is amend-consent's sibling: the
// customer refusing a booked-order price change instead of signing it. Same
// capability-token model, same CAS-guarded write, distinct from the plain
// 'decline' below (that one is the pre-booking QuoteResponseModal decline on
// a sent/viewed quote — a different lifecycle stage, different route).
const PUBLIC_QUOTE_SUBROUTES = new Set([
  'approve',
  'amend-consent',
  'amend-decline',
  'pay',
  'pay-balance', // customer pays the remaining 50% balance (#83 pay-link)
  'view',
  'decline',
  'request-changes',
  'interested',
  'selection', // ledger row 239 — debounced browsing-selection autosave; route refuses once approved
  'simulate-deposit', // TEST quotes only — route re-checks is_test (#81 W6-008)
]);

// Customer quote sub-routes that are METHOD-SCOPED, unlike the method-blind set
// above. Same capability-token model (the quote UUID is the credential), but
// each opens only the verb the portal actually uses. Both were shipped as
// public by their route authors — neither has an operator gate of its own, so
// this list is the ONLY thing in front of them — and both were missed here,
// which 401'd real customers while working fine for any logged-in operator.
const PUBLIC_QUOTE_SUBROUTES_BY_METHOD: Record<string, string> = {
  // The three document links on the approved portal page (quote / invoice /
  // receipt). Its route header notes it has no separate operator gate so the
  // SAME link serves customer and staff.
  pdf: 'GET',
  // The portal colour picker's request against a BOOKED order (#163) — per its
  // route header, the only path to change a booked order's colours.
  'color-change-request': 'POST',
  // Ledger row 236 — the "Want to reopen your quote? Let us know!" ask on a
  // declined/abandoned quote's read-only portal (StickyBottomBar's
  // terminalBrowse branch). POST only; no separate operator gate of its own.
  'reopen-request': 'POST',
};

// Public, empty-form pages listed one by one rather than by prefix, so
// adding a page is a deliberate act. These read no customer record, which is
// why they are safe to serve signed-out. The first four are the embeddable
// non-lead forms (#195); referral-link is the self-serve referral link
// request page (naldo/referral-self-serve).
const PUBLIC_FORM_PAGES = new Set([
  '/forms/newsletter',
  '/forms/careers',
  '/forms/intern',
  '/forms/nomination',
  '/referral-link',
]);

// Exact public API paths (webhooks + crons + the login surface).
const PUBLIC_API_EXACT = new Set([
  '/api/login',
  '/api/health', // uptime monitor probe — booleans/timestamp only, no PII/secrets (#81 W6-001)
  '/api/integrations/valor/webhook', // Valor deposit webhook (HMAC-verified in the route)
  '/api/integrations/valor/redirect-capture', // #161 diagnostic probe — Valor's redirect_url S2S callback target (values never logged/stored; see route header). Method-blind like the webhook entry above, so both GET (the possible human-browser leg) and POST (the presumed S2S leg) are covered.
  '/api/integrations/homeworks/signed', // home.works signed webhook (shared-secret in the route)
  '/api/integrations/whatsapp/webhook', // Twilio WhatsApp webhook (signature-verified in the route, #82)
  '/api/integrations/telegram/webhook', // Telegram Bot webhook (secret-token verified in the route, #82 alt channel)
  '/api/integrations/bouncie/webhook', // Bouncie fleet-GPS webhook (shared-secret verified in the route, row 403 phase 2) — a Bouncie request carries no operator session, so without this entry the perimeter 401s it before the route's own secret check runs. Capture-only: the route writes to vehicle_events and nothing else, never to job_segments/shifts/jobs (constraint (a): GPS never writes payroll).
  '/api/inventory/purchase-order/auto-send', // Vercel Cron (CRON_SECRET-guarded, #82 auto-PO)
  '/api/inventory/low-stock-alert', // Vercel Cron (CRON_SECRET-guarded, #82 low-stock alarm)
  '/api/dashboard/ghl/reconcile', // Vercel Cron (CRON_SECRET-guarded, #58 inbox safety-net poll)
  '/api/dashboard/ghl/webhook', // GHL "Customer Replied" webhook (shared-secret in the route, #58)
  '/api/dashboard/escalate', // Vercel Cron (CRON_SECRET-guarded, #58 escalation engine)
  '/api/dashboard/quotetool/reconcile', // Vercel Cron (CRON_SECRET-guarded, #58 quote-lead fold-in)
  '/api/dashboard/gmail/poll', // Vercel Cron (CRON_SECRET-guarded, #58 Gmail inbox ingestion)
  '/api/dashboard/ingest', // Generic source ingest (shared-secret in the route, #58 Homeworks etc.)
  '/api/ops/digest', // Vercel Cron (CRON_SECRET-guarded, #168 morning ops digest — same Bearer guard as low-stock-alert; a cron request carries no operator session so it must be allowlisted to reach its own CRON_SECRET check)
  '/api/ops/midnight-close', // Vercel Cron (CRON_SECRET-guarded, row 281 P4P midnight auto-close for forgotten days) — same reason as the digest above: a cron carries no session, so without this entry the perimeter 401s it before its own secret check ever runs.
  '/api/ops/vehicle-poll', // Vercel Cron (CRON_SECRET-guarded, row 403 fleet position poll) — same reason as every cron here: no operator session, so the perimeter must let it reach its own secret check. Writes vehicle positions and visits only; never payroll (constraint (a)).
  '/api/inventory/prep-digest', // Vercel Cron (CRON_SECRET-guarded, #666 daily prep digest — was silently 401'd by this perimeter from #666's merge until the S47 wrap review caught it)
  '/api/jobs/completing-today', // Vercel Cron (CRON_SECRET-guarded, #666 completing-today Jobs ping — same gap, same fix)
  '/api/leads/retry', // Vercel Cron (CRON_SECRET-guarded, #leads GHL-outage retry worker) — a cron
  // request carries no operator session, so it must be allowlisted here to reach
  // its own CRON_SECRET check (the /api/leads carve-out below is exact-match +
  // POST/OPTIONS only, so it does NOT cover this GET sub-path). The sibling
  // /api/admin/leads* routes are requireAdmin (operator-session) and stay gated.
  '/api/referrals/sweep', // Vercel Cron (CRON_SECRET-guarded, naldo/referral-link-sweep), same
  // reason as every other cron above: a scheduled request carries no operator
  // session, so it must be allowlisted here to reach its own CRON_SECRET check.
  '/api/cron/calls-sync', // Vercel Cron (CRON_SECRET-guarded, calls_merge_plan_2026-08.md slice
  // S2) — same reason as every other cron above: a scheduled request carries
  // no operator session, so it must be allowlisted here to reach its own
  // CRON_SECRET check. Also gated by its own CALLS_SYNC_ENABLED flag
  // (default off) inside the route, per decision 5.
  '/api/cron/calls-extract', // Vercel Cron (CRON_SECRET-guarded, calls_merge_plan_2026-08.md
  // slice S6) — same reason as every other cron above: a scheduled request
  // carries no operator session, so it must be allowlisted here to reach its
  // own CRON_SECRET check. Also gated by its own CALLS_EXTRACT_ENABLED flag
  // (default off) inside the route, per decision 5.
  '/api/ops/installment-run', // The installment runner (row 448). NOT in vercel.json yet — no
  // cron is armed (Jason's call 2026-08-28, dry-run first) — but the entry lands
  // WITH the route rather than with the schedule, because the failure this list
  // exists to prevent is exactly a cron added later without it and silently 401'd
  // before its own CRON_SECRET check runs (S42/S44/S47). Allowlisted here means
  // "the perimeter lets it reach its own auth", not "public": the route answers a
  // request with an Authorization header via cronDenial and one without via
  // requireOperator, so an anonymous caller is refused either way.
]);

// Bare /api/quotes/<uuid> — matches ONLY an id segment (no further sub-path),
// so it can't accidentally swallow /api/quotes/<id>/<sub>.
const QUOTE_BY_ID_RE = /^\/api\/quotes\/[^/]+$/;

/**
 * True when `pathname` (+ optional HTTP `method`) is reachable WITHOUT operator
 * authentication — the customer portal, its customer-triggered APIs, public
 * webhooks + crons, public image assets, and the login surface. Everything else
 * is operator-only.
 *
 * `method` defaults to GET when omitted (callers that only ever check GET-able
 * surfaces, e.g. tests, don't need to pass it) — this is method-BLIND for every
 * path except the bare quote-id route below, where it matters: GET is the public
 * capability-token read (#81 W6-005), but DELETE on that same path is an
 * operator-only action and must stay gated.
 */
/**
 * The advertising-only surface: `/advertising` (pages) and `/api/advertising`
 * (its APIs). Confined at the perimeter for the same reason the retired crew
 * population was (row 438) — an
 * advertising session must be confined to exactly this surface at the
 * perimeter, which otherwise admits any authenticated user onto the operator
 * surface and its customer PII.
 *
 * Naldo's 2026-08-27 ruling: advertising gets a real future surface here
 * (`/advertising` pages, `/api/advertising/**` routes), never a widened
 * `OperatorRole`. Both prefixes are EMPTY today — no advertising page or route
 * exists yet — and that is expected: this ships the population lock (the
 * marker + the perimeter confinement) before the first advertising surface
 * does, so nothing has to race to land guard and surface in the same PR.
 *
 * Positive allowlist, prefix-matched: a future
 * `/api/advertising/campaigns` needs no change here.
 */
export function isAdvertisingPath(pathname: string): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return (
    path === '/advertising' ||
    path.startsWith('/advertising/') ||
    path === '/api/advertising' ||
    path.startsWith('/api/advertising/')
  );
}

export function isPublicPath(pathname: string, method: string = 'GET'): boolean {
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

  // Referral landing page (ledger #41) — public, gated only by the referral
  // code in the URL (a bad/unknown code just 404s inside the page itself).
  if (path === '/refer' || path.startsWith('/refer/')) return true;

  // Customer self-serve estimate (ledger self-serve, Phase A) — the public
  // "type your address, get an instant range" front door. The page + its two
  // APIs self-gate on the SELF_SERVE_ESTIMATE_ENABLED flag (404 when off) and
  // are honeypot + rate-limited in the routes themselves. EXACT match only — the
  // one page is `/estimate` (the embed uses a ?embed=1 QUERY, not a sub-path), so
  // a future `/estimate/<something>` must be allowlisted deliberately, never
  // shipped public by a prefix (defense-in-depth, review 2026-07-20).
  if (path === '/estimate') return true;

  // The home-screen install page (naldo/mobile-app-branding). It lists the two
  // installable apps — the quote tool and the advertising capture — with a QR
  // code and add-to-home-screen steps for each, so Naldo can text one URL to a
  // new staffer instead of walking them through it. It reads no customer record
  // and no database at all: the only thing on it is two of our own URLs, which
  // is why it is safe signed-out. EXACT match, mirroring /estimate above, so a
  // future /install/<something> must be allowlisted deliberately.
  if (path === '/install') return true;

  // The two web manifests those installs read. These MUST be public even though
  // both apps behind them are operator-only: a <link rel="manifest"> is fetched
  // with credentials omitted, so a gated manifest 401s for a SIGNED-IN operator
  // too, and iOS then falls back to a screenshot of the page — the black square
  // this whole change exists to fix. They contain nothing but app names, colours
  // and icon paths. Note the middleware matcher already excludes .png, so the
  // icon files themselves never reach this gate; .webmanifest is not on that
  // extension list, which is why these two need naming here.
  if (path === '/manifest-quote.webmanifest' || path === '/manifest-advertising.webmanifest') {
    return true;
  }

  // Exact public APIs (webhooks + crons + login).
  if (PUBLIC_API_EXACT.has(path)) return true;

  // Customer quote sub-routes: /api/quotes/<id>/(approve|pay|view|decline|request-changes|interested|simulate-deposit).
  const m = /^\/api\/quotes\/[^/]+\/([^/]+)$/.exec(path);
  if (m && PUBLIC_QUOTE_SUBROUTES.has(m[1]!)) return true;
  if (m && PUBLIC_QUOTE_SUBROUTES_BY_METHOD[m[1]!] === method.toUpperCase()) return true;

  // Bare /api/quotes/<id> GET is the public capability-token portal read; DELETE
  // on the same path is operator-only and must NOT be allowlisted (#81 W6-005).
  if (method.toUpperCase() === 'GET' && QUOTE_BY_ID_RE.test(path)) return true;

  // GET /api/inventory/offered-colors is the anonymous customer portal's color
  // picker (DesignCanvas) — non-sensitive data (color ids only). Route-level auth
  // was removed from this endpoint in #469, but this perimeter list is a SECOND,
  // independent gate in front of it (the middleware default-denies before the
  // route ever runs), so #469 alone wasn't sufficient — prod kept 401'ing. GET
  // only; other methods on this exact path stay operator-gated (S26).
  if (method.toUpperCase() === 'GET' && path === '/api/inventory/offered-colors') {
    return true;
  }

  // POST /api/referrals/submit is the referral landing page's public lead-
  // capture form (ledger #41) — rate-limited + code-revalidated in the route
  // itself. POST only; other methods on this exact path stay operator-gated
  // (mirrors the offered-colors GET-only carve-out, S26).
  if (method.toUpperCase() === 'POST' && path === '/api/referrals/submit') {
    return true;
  }

  // POST /api/referrals/request-link is the self-serve referral link request
  // (naldo/referral-self-serve): a visitor types an email, and the route
  // rate-limits, honeypot-checks, and validates before doing anything. POST
  // only; other methods on this exact path stay operator-gated (mirrors the
  // /api/referrals/submit carve-out directly above).
  if (method.toUpperCase() === 'POST' && path === '/api/referrals/request-link') {
    return true;
  }

  // Self-serve estimate APIs (ledger self-serve, Phase A) — the public front
  // door's measure/price + contact-capture endpoints. POST only (each is
  // flag-gated + honeypot + rate-limited in the route); other methods stay
  // operator-gated. Same shape as the referrals carve-out above.
  if (
    method.toUpperCase() === 'POST' &&
    (path === '/api/estimate' || path === '/api/estimate/contact' || path === '/api/estimate/upload')
  ) {
    return true;
  }

  // GET /api/estimate/design — the self-serve result screen polls this for the
  // measured-roofline visual (ledger self-serve, Slice 3). It's flag-gated +
  // rate-limited in the route and returns the same { scene, photoUrl } the portal
  // hero already exposes by UUID. GET only; other methods stay operator-gated.
  if (method.toUpperCase() === 'GET' && path === '/api/estimate/design') {
    return true;
  }

  // GET /api/estimate/samples — the landing's featured real-job gallery (S48).
  // Flag-gated + rate-limited; returns house renders only (no PII), the same shape
  // the portal exposes. GET only; other methods stay operator-gated.
  if (method.toUpperCase() === 'GET' && path === '/api/estimate/samples') {
    return true;
  }

  // /api/leads is the WordPress site's public lead-capture endpoint (#leads) —
  // honeypot + rate-limited + strictly validated in the route itself. POST is
  // the submission; OPTIONS must also pass because the browser sends a CORS
  // preflight for the cross-origin JSON POST from yulelovelights.com (the
  // referrals carve-out above never needed this — its form is same-origin).
  // All other methods on this path stay operator-gated.
  // /api/leads/partial is the abandoned-form sibling (#leads partial-save): the
  // same embed fires it on contact-field blur and on page-leave, from the same
  // cross-origin WordPress page, and it self-gates the same way (honeypot +
  // per-IP call/insert caps + a required contact handle). Shipping it without
  // this entry default-denied every real visitor's partial with a 401 —
  // invisible in testing because an operator's own session passes the gate (S42).
  // NOTE the preflight rationale above is /api/leads-specific: that form POSTs
  // application/json, which forces an OPTIONS preflight. The partial capture
  // posts text/plain (fetch AND sendBeacon), a CORS-SIMPLE request that is never
  // preflighted, so OPTIONS is not load-bearing here. It is allowed anyway, to
  // stay consistent with its sibling and to avoid a mystery 401 if the payload
  // ever moves to application/json — the handler only echoes CORS headers and
  // touches neither the database nor GHL.
  if (path === '/api/leads' || path === '/api/leads/partial') {
    const m = method.toUpperCase();
    if (m === 'POST' || m === 'OPTIONS') return true;
  }

  // The non-lead website forms (#195): the newsletter signup in the footer of
  // every marketing page, the job and intern applications, and the Light Up For
  // Hope nomination. Each is an <iframe> on yulelovelights.com, so the visitor
  // is never signed in here — without this entry the perimeter default-denies
  // and the "form" a homeowner sees is our login screen. Same trap that
  // silently 401'd every real partial lead capture (S42) and the morning digest
  // cron (S47): invisible in testing, because an operator's own session passes.
  //
  // EXACT match per form type, never a `/forms/` prefix — a future
  // `/forms/<something-sensitive>` must be allowlisted deliberately, mirroring
  // the /estimate reasoning above.
  if (PUBLIC_FORM_PAGES.has(path)) return true;

  // POST /api/site-forms is those forms' submission endpoint (honeypot +
  // timing + per-IP rate limit + strict validation in the route itself).
  // OPTIONS must pass too: the forms POST application/json cross-origin from
  // yulelovelights.com, which forces a CORS preflight — exactly the /api/leads
  // case above. All other methods stay operator-gated.
  if (path === '/api/site-forms') {
    const m = method.toUpperCase();
    if (m === 'POST' || m === 'OPTIONS') return true;
  }

  return false;
}
