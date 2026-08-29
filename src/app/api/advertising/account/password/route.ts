import { NextRequest, NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { createRouteSupabase } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

/**
 * Self-service password change for a signed-in ADVERTISING worker (the
 * Settings screen's Change Password). Mirrors /api/account/password exactly:
 * the caller's OWN session via auth.updateUser — it can only ever change the
 * caller's own password, never a role (app_metadata is admin-only). Lives
 * under /api/advertising so the population-confined perimeter admits it.
 */
export async function POST(req: NextRequest) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  const sb = await createRouteSupabase();
  if (!sb) return NextResponse.json({ error: 'Auth not configured on server' }, { status: 503 });

  const { error } = await sb.auth.updateUser({ password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
