// Operator-surface auth perimeter (ledger #81, Option B — Supabase Auth).
//
// #110 W6-013: Next.js 16 renamed the `middleware` convention to `proxy` (same
// file location, same behavior — see node_modules/next/dist/docs/01-app/
// 01-getting-started/16-proxy.md). This is that rename: `src/middleware.ts` →
// `src/proxy.ts`, exported `middleware` → `proxy`. Functionality is byte-identical.
//
// Default-deny: every request is operator-only unless isPublicPath() allows it
// (the customer portal, customer-triggered quote APIs, public webhooks, image
// assets, and the login surface). When enabled, access requires a valid
// per-user Supabase session (validated via getUser()); the old shared
// ADMIN_SECRET is gone. The allow/deny boundary lives in
// src/lib/auth/operatorGate.ts (pure + unit-tested); this file wires it to the
// request and chooses the rejection (401 for APIs, redirect to /login for pages).
//
// ⚠️ Ships DORMANT (AUTH_GATE_ENABLED!=='true' → no-op) so it's safe to merge +
// review without changing behavior. Go-live = seed the first admin, log in to
// verify, then flip AUTH_GATE_ENABLED=true in Vercel (zero-lockout — see #81).

import { NextRequest, NextResponse } from 'next/server';
import { isCrewPath, isPublicPath } from '@/lib/auth/operatorGate';
import { createMiddlewareSupabase, isCrewAccount } from '@/lib/auth/supabaseServer';

export async function proxy(req: NextRequest) {
  // DORMANT BY DEFAULT.
  if (process.env.AUTH_GATE_ENABLED !== 'true') return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname, req.method)) return NextResponse.next();

  // Authenticated operator? getUser() re-validates the JWT server-side (not the
  // unverified getSession). `res` carries any rotated session cookies, so we
  // return it on the authenticated path.
  const { supabase, res } = createMiddlewareSupabase(req);
  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      // ROLE-AWARE, not merely authenticated. Naldo's 2026-08-16 ruling put crew
      // logins in the SAME auth store as operator logins, so "has a session" no
      // longer implies "may see the operator surface" — and that surface holds
      // customer PII. A crew session may reach ONLY the crew API; everywhere
      // else it is refused. Route handlers enforce this again via requireCrew /
      // requireOperator (defense in depth), but this is the perimeter half, and
      // it is the half that covers operator PAGES that lean on the perimeter
      // rather than calling requireOperator themselves.
      if (isCrewAccount(user.app_metadata) && !isCrewPath(pathname)) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const denied = req.nextUrl.clone();
        denied.pathname = '/login';
        denied.searchParams.set('error', 'crew-account');
        return NextResponse.redirect(denied);
      }
      return res;
    }
  }

  // Unauthenticated (or Supabase unconfigured → fail closed).
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('from', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static files. isPublicPath()
  // does the real allow/deny — this matcher is only a performance prefilter.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|webp|svg|gif|ico|css|js|map|txt|woff|woff2)$).*)',
  ],
};
