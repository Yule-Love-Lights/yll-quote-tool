// Operator login (ledger #81, Option B — Supabase Auth).
//
// POST /api/login { email, password } → signs in against Supabase Auth and sets
// the SSR session cookies the middleware validates on every subsequent request.
// Per-user identity (no more shared ADMIN_SECRET password). Login is server-side
// so the browser never needs a Supabase client or public keys. Generic error on
// failure (no account enumeration).

import { NextRequest, NextResponse } from 'next/server';
import { createRouteSupabase } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let email = '';
  let password = '';
  try {
    const body = (await req.json()) as { email?: unknown; password?: unknown };
    if (typeof body.email === 'string') email = body.email.trim();
    if (typeof body.password === 'string') password = body.password;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  const supabase = await createRouteSupabase();
  if (!supabase) {
    return NextResponse.json({ error: 'Auth not configured on server' }, { status: 503 });
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Generic message — don't reveal whether the email exists.
    return NextResponse.json({ error: 'Incorrect email or password' }, { status: 401 });
  }

  // The SSR client set the session cookies on this response via setAll().
  return NextResponse.json({ ok: true });
}
