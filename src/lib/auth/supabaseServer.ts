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

function env(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
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
  });
}

export type OperatorRole = 'admin' | 'operator';
export type Operator = { id: string; email: string | null; role: OperatorRole };

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

/**
 * The authenticated operator for the current request, or null. Validates the JWT
 * against Supabase (getUser — a server-side check, not the unverified
 * getSession). Used by route handlers + server components as the per-call gate
 * (defense in depth behind the middleware perimeter).
 */
export async function getOperator(): Promise<Operator | null> {
  const supabase = await createRouteSupabase();
  if (!supabase) return null;
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return { id: user.id, email: user.email ?? null, role: roleOf(user.app_metadata) };
}

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
