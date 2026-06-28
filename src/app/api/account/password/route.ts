// Self-service password change for the logged-in operator (ledger #81 Slice 3).
//
// POST /api/account/password  { password }
//
// Uses the caller's OWN Supabase session (createRouteSupabase → auth.updateUser),
// NOT the service-role admin API — so it can only ever change the caller's own
// password, never another user's, and it cannot change a role (app_metadata is
// admin-only). Available to ANY logged-in operator, admin or not.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, createRouteSupabase } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  const sb = await createRouteSupabase();
  if (!sb) return NextResponse.json({ error: 'Auth not configured on server' }, { status: 503 });

  const { error } = await sb.auth.updateUser({ password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
