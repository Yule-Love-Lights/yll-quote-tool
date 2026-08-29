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
// Engaged by default. Dormant ONLY on the explicit AUTH_GATE_ENABLED=false
// opt-out (ledger #347) — see authGateEngaged()'s doc comment in
// supabaseServer.ts for why dormancy is never inferred from the Supabase env
// being unconfigured (that would be a NEW fail-open on a prod misconfig).

import { NextRequest, NextResponse } from 'next/server';
import { isAdvertisingPath, isPublicPath } from '@/lib/auth/operatorGate';
import {
  authGateEngaged,
  createMiddlewareSupabase,
  isAdvertisingAccount,
  isCrewAccount,
} from '@/lib/auth/supabaseServer';

export async function proxy(req: NextRequest) {
  if (!authGateEngaged()) return NextResponse.next(); // deliberately opted out

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
      // ROLE-AWARE, not merely authenticated. Crew logins shared the operator
      // auth store, so "has a session" never implied "may see the operator
      // surface" — and that surface holds customer PII.
      //
      // Crew logins were RETIRED (row 438, 2026-08-28) along with the
      // `/api/ops/v1` surface they existed to reach, and nothing mints one any
      // more. This refusal STAYS, and is now unconditional, because deleting it
      // would do the opposite of cleaning up: `roleOf` collapses every non-admin
      // role to 'operator', so a crew account that appeared later — created by
      // hand in the Supabase dashboard, say — would be silently PROMOTED to the
      // operator surface. That is the escalation recorded in AGENTS.md. Fail
      // closed: no crew account reaches anything. `getOperator` returns null on
      // the same marker, which is the defense-in-depth half.
      if (isCrewAccount(user.app_metadata)) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const denied = req.nextUrl.clone();
        denied.pathname = '/login';
        denied.searchParams.set('error', 'crew-account');
        return NextResponse.redirect(denied);
      }
      // Same seam as the crew branch above, for the advertising population
      // (Naldo's 2026-08-27 ruling). The advertising surface is live as of
      // the workstream B build: isAdvertisingPath() names /advertising and
      // /api/advertising/**, and this branch confines every advertising
      // session to exactly that surface, without ever widening the crew
      // branch above. The reachability matrix is pinned by
      // src/lib/auth/advertisingPerimeter.test.ts.
      if (isAdvertisingAccount(user.app_metadata) && !isAdvertisingPath(pathname)) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const denied = req.nextUrl.clone();
        denied.pathname = '/login';
        denied.searchParams.set('error', 'advertising-account');
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
