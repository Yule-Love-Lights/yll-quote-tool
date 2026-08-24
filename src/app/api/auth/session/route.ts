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
  return NextResponse.json({ signedIn: operator !== null });
}
