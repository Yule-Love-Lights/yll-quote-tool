// Operator session check (ledger #347). GET /api/auth/session → whether THIS
// request carries a real, valid operator session — never gated by
// authGateEngaged()/requireOperator()'s dormancy opt-out, because the whole
// point is to answer truthfully even while the gate is deliberately off (see
// OperatorNav.tsx, which uses this to decide whether "Sign out" should render
// at all: it used to render unconditionally, so a signed-out browser on a
// dormant gate LOOKED signed in).

import { NextResponse } from 'next/server';
import { getOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function GET() {
  const operator = await getOperator();
  // The caller's own role rides along when signed in (ops hub workstream A
  // slice 2): OperatorNav gates its admin-only View-as control on it, and
  // this route is the session answer it already fetches. Never present when
  // signed out.
  if (!operator) return NextResponse.json({ signedIn: false });
  // Name and email ride along so the header account menu can say WHO is signed
  // in (Naldo, 2026-08-30). Both were already on the Operator record; this
  // route simply never returned them. Nothing secret: it is the caller's own
  // identity, answered only for a caller who already holds the session.
  return NextResponse.json({
    signedIn: true,
    role: operator.role,
    name: operator.name,
    email: operator.email,
  });
}
