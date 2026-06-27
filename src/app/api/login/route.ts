// PROPOSAL — operator login (see docs/audit/AUTH-PROPOSAL.md).
//
// POST /api/login  { password }  → if it matches ADMIN_SECRET, set an httpOnly
// session cookie that the middleware accepts on every subsequent request. This
// interim mechanism reuses the existing ADMIN_SECRET as a shared staff password
// (no per-user identity yet — that's the decision the proposal raises). httpOnly
// is already an improvement over today's sessionStorage secret (not JS-readable,
// so it can't be exfiltrated by an injected script).

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual, OPERATOR_COOKIE } from '@/lib/auth/operatorGate';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured on server' }, { status: 503 });
  }

  let password = '';
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password === 'string') password = body.password;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!password || !safeEqual(password, secret)) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(OPERATOR_COOKIE, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12, // 12h operator session
  });
  return res;
}
