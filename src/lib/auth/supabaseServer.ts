// Supabase SSR auth clients (ledger #81 — operator auth perimeter, Option B).
//
// The operator surface is gated on a real per-user Supabase session (NOT the
// old shared ADMIN_SECRET). This module builds the @supabase/ssr server clients
// that read/refresh the session cookie:
//   • createMiddlewareSupabase(req) — for the edge middleware (the perimeter).
//   • createRouteSupabase()         — for route handlers + server components.
//   • getOperator()                 — the authenticated operator (+ role), or null.
//
// Uses the ANON key + the user's JWT from cookies (NOT the service-role key —
// that stays server-only in supabase.ts). Login itself is server-side
// (/api/login) so the browser never needs a Supabase client or public keys.

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { cache } from 'react';

function env(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

// #185 (inbox slowness): a hard timeout on the auth-gate's GoTrue calls
// (getUser, and the session-refresh POST auth-js silently fires when the
// stored token is within its ~90s expiry margin). auth-js has NO built-in
// timeout on these — a degraded/hanging GoTrue leg blocks the whole request
// with ZERO errors logged, which was the #185 investigation's root cause.
// AbortController + a timer mirrors the existing valorBalance.ts / valor.ts
// TIMEOUT_MS pattern already used for other outbound calls this app doesn't
// control. On abort, auth-js's own _getUser() catches the resulting
// AuthRetryableFetchError and returns { data: { user: null }, error } — the
// SAME shape as an invalid/expired session — so getOperator() and proxy.ts
// already fail closed on it (return null / redirect-to-login /
// 401) with no further changes; the console.error below is just so the
// timeout itself is visible in the server log instead of reading as a plain
// "no session".
//
// SCOPE — read before touching: this wraps ONLY the fetch used by the two
// ANON-key SSR clients below (createMiddlewareSupabase / createRouteSupabase),
// i.e. the operator-auth-gate's session checks. It must NEVER wrap the
// service-role DATA client (getSupabaseServiceClient in src/lib/supabase.ts,
// a separate module) — that client backs long-running PostgREST reads/writes
// (a charge-balance call, a webhook write) that must not be aborted by an
// auth-sized timeout. Note getOperatorLabels()'s auth.admin.listUsers() call
// (src/lib/dashboard/inbox/store.ts) also rides that SAME service-role client
// for its Postgres access, so it is intentionally NOT covered by this timeout
// either — timing it out would need splitting that client, which is out of
// scope here.
const DEFAULT_AUTH_FETCH_TIMEOUT_MS = 5000;

function authFetchTimeoutMs(): number {
  const raw = Number(process.env.AUTH_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTH_FETCH_TIMEOUT_MS;
}

/**
 * A `fetch` that aborts after `timeoutMs` (env-overridable via
 * AUTH_FETCH_TIMEOUT_MS, default 5000). Exported for unit testing — see the
 * SCOPE comment above for where this may and may not be used.
 */
export function withAuthFetchTimeout(timeoutMs: number = authFetchTimeoutMs()) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        console.error(`[auth] GoTrue fetch timed out after ${timeoutMs}ms — failing the auth gate closed`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Middleware (edge) client. Returns the Supabase client plus the NextResponse it
 * must write refreshed-session cookies onto — the caller returns `res` on the
 * authenticated path so the rotated tokens propagate. `supabase` is null when
 * Supabase isn't configured (the caller then fails closed).
 */
export function createMiddlewareSupabase(req: NextRequest): {
  supabase: ReturnType<typeof createServerClient> | null;
  res: NextResponse;
} {
  const res = NextResponse.next({ request: req });
  const cfg = env();
  if (!cfg) return { supabase: null, res };
  const supabase = createServerClient(cfg.url, cfg.key, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
    global: { fetch: withAuthFetchTimeout() },
  });
  return { supabase, res };
}

/**
 * Route-handler / server-component client, backed by next/headers cookies().
 * null when Supabase isn't configured.
 */
export async function createRouteSupabase(): Promise<ReturnType<typeof createServerClient> | null> {
  const cfg = env();
  if (!cfg) return null;
  const cookieStore = await cookies();
  return createServerClient(cfg.url, cfg.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Setting cookies throws in a Server Component (read-only). Safe to
          // ignore — the middleware refreshes the session on the next request.
        }
      },
    },
    global: { fetch: withAuthFetchTimeout() },
  });
}

export type OperatorRole = 'admin' | 'operator';
export type Operator = { id: string; email: string | null; role: OperatorRole; name: string | null };

/**
 * Derive the operator role from a user's app_metadata. PURE. Admin ONLY when the
 * role is exactly the string 'admin'; everything else (missing, 'operator', a
 * spoofed object, null) is 'operator'. app_metadata is set only via the
 * service-role admin API, so a user can't self-elevate by editing their own
 * profile — this is the security-relevant invariant.
 */
export function roleOf(appMetadata: unknown): OperatorRole {
  const role = (appMetadata as { role?: unknown } | null | undefined)?.role;
  return role === 'admin' ? 'admin' : 'operator';
}

/** The marker on a crew login. Writable only through the service-role admin API. */
export const CREW_ROLE = 'crew';

/**
 * True when this account is a CREW login rather than an operator one. PURE.
 *
 * Naldo's 2026-08-16 ruling put crew logins in the SAME auth store as operator
 * logins, so one login serves both the Quote Tool and the Operations Hub. Shared
 * identity is NOT shared authorization, and this function is that seam.
 *
 * ⚠️ WHY THIS HAD TO EXIST BEFORE THE FIRST CREW ACCOUNT DID: `roleOf` above
 * returns 'operator' for ANYTHING that is not exactly 'admin' — including
 * 'crew'. So a crew login would have satisfied `requireOperator` and reached
 * `/customers` and its customer PII. `getOperator` now returns null for these
 * accounts, closing it at the route layer, and `src/proxy.ts` closes it at the
 * perimeter (which otherwise admits ANY authenticated user).
 */
export function isCrewAccount(appMetadata: unknown): boolean {
  return (appMetadata as { role?: unknown } | null | undefined)?.role === CREW_ROLE;
}

/**
 * Derive the operator's display name from app_metadata. PURE. Returns the trimmed
 * name, or null when absent/blank/forged (legacy accounts) — callers fall back to
 * email. Stored in app_metadata (admin-only, like role) — NOT user_metadata — so
 * an operator can't spoof "who did the work": the self-service /api/account/password
 * route's auth.updateUser only writes user_metadata. NEVER move name to
 * user_metadata or accept it in a self-service updateUser({data}) payload.
 */
export function nameOf(appMetadata: unknown): string | null {
  const name = (appMetadata as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * The authenticated operator for the current request, or null. Validates the JWT
 * against Supabase (getUser — a server-side check, not the unverified
 * getSession). Used by route handlers + server components as the per-call gate
 * (defense in depth behind the middleware perimeter).
 *
 * #185: wrapped in React's cache() so multiple getOperator()/requireOperator()/
 * requireAdmin() calls made while rendering the SAME request (e.g. a page and a
 * nested server component both needing the operator) share ONE GoTrue round-
 * trip instead of firing a fresh client + fetch each time. Scope note: cache()
 * dedupes within one Server Component render (or one Route Handler invocation)
 * — it does NOT and CANNOT span the proxy middleware (proxy.ts — Node runtime
 * in Next 16, but a separate invocation outside the RSC render tree, with its
 * own createMiddlewareSupabase().auth.getUser() call) or a
 * separate Route Handler's own invocation, so those two auth round-trips stay
 * genuinely separate calls; this only removes DUPLICATE getOperator() calls
 * within a single render/invocation. In the Vitest resolution of 'react' (the
 * plain, non-"react-server" build) cache() is a pass-through no-op, so this
 * unit test suite is unaffected either way — the memoization only activates
 * under Next.js's real RSC/Route-Handler dispatcher.
 */
export const getOperator = cache(async (): Promise<Operator | null> => {
  const supabase = await createRouteSupabase();
  if (!supabase) return null;
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  // A crew login is NOT an operator. Returning null here is what makes
  // requireOperator and requireAdmin reject crew accounts; without it `roleOf`
  // would classify 'crew' as 'operator' and hand them the operator surface.
  if (isCrewAccount(user.app_metadata)) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    role: roleOf(user.app_metadata),
    name: nameOf(user.app_metadata),
  };
});

/**
 * Per-route operator guard — the route-handler counterpart of the middleware
 * perimeter (defense in depth). DORMANT unless AUTH_GATE_ENABLED==='true':
 * returns null (allow) when the gate is off, so wiring it into a route changes
 * nothing until go-live — important because the Supabase auth env isn't
 * configured until then, and a hard getOperator() gate would 401 every operator
 * route while still dormant. When enabled, requires a valid operator session and
 * otherwise returns a 401 the handler should return directly:
 *
 *   const denied = await requireOperator();
 *   if (denied) return denied;
 */
export async function requireOperator(): Promise<NextResponse | null> {
  if (process.env.AUTH_GATE_ENABLED !== 'true') return null; // dormant — allow
  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return null;
}

/**
 * STRICT admin gate for account-management routes. UNLIKE requireOperator, this
 * is NEVER dormancy-bypassed: account CRUD has no dormant use case and must fail
 * closed (an anonymous create-user would be a hole), and these routes are new so
 * there is no existing behavior to preserve. Returns the authenticated admin, or
 * a NextResponse (401 unauthenticated / 403 non-admin) to return directly:
 *
 *   const auth = await requireAdmin();
 *   if ('response' in auth) return auth.response;
 *   const caller = auth.operator;
 */
export async function requireAdmin(): Promise<{ operator: Operator } | { response: NextResponse }> {
  const operator = await getOperator();
  if (!operator) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (operator.role !== 'admin') {
    return { response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
  }
  return { operator };
}
