// Marks the caller's browser as a STAFF device (ledger S22 — staff-view
// suppression). Fired once per session by the operator console (OperatorShell)
// so that a staff preview of a customer's /portal/[id] link doesn't count as a
// customer view/interest or fire the "quote viewed" staff email.
//
// POST /api/operator/mark-device  →  { ok: true } + Set-Cookie
//
// Intentionally UNGATED: the cookie only SUPPRESSES this one browser's own view
// notifications and touches no data, so there's no incentive for a customer to
// self-mark. Only the operator console ever calls it (the customer portal never
// mounts OperatorShell). When operator login goes live, getOperator() is the
// authoritative staff signal — this stays as the no-login bridge.

import { NextResponse } from 'next/server';
import { STAFF_DEVICE_COOKIE } from '@/lib/auth/staffDevice';

export const runtime = 'nodejs';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(STAFF_DEVICE_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  return res;
}
