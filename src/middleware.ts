// PROPOSAL — operator-surface auth gate. See docs/audit/AUTH-PROPOSAL.md.
//
// Default-deny: every request is operator-only unless isPublicPath() allows it
// (the customer portal, customer-triggered quote APIs, public webhooks, image
// assets, and the login surface). The real allow/deny logic lives in
// src/lib/auth/operatorGate.ts (pure + unit-tested); this file just wires it to
// the request and chooses the rejection (401 for APIs, redirect to /login for
// pages). It accepts the existing x-admin-secret header too, so the current
// /admin/quotes calls keep working unchanged.
//
// ⚠️ DO NOT ENABLE WITHOUT: (1) choosing the auth mechanism (this interim
// version uses the existing ADMIN_SECRET as a shared password — see the
// proposal), and (2) a runtime pass confirming no customer route is gated.

import { NextRequest, NextResponse } from 'next/server';
import { isPublicPath, hasValidOperatorAuth, OPERATOR_COOKIE } from '@/lib/auth/operatorGate';

export function middleware(req: NextRequest) {
  // DORMANT BY DEFAULT. The gate only activates when AUTH_GATE_ENABLED=true, so
  // this file is safe to merge and review without changing behavior — flip the
  // env var only after the runtime verification in AUTH-PROPOSAL.md passes.
  if (process.env.AUTH_GATE_ENABLED !== 'true') return NextResponse.next();

  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  const authorized = hasValidOperatorAuth(
    {
      cookie: req.cookies.get(OPERATOR_COOKIE)?.value,
      header: req.headers.get('x-admin-secret'),
    },
    process.env.ADMIN_SECRET,
  );
  if (authorized) return NextResponse.next();

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
