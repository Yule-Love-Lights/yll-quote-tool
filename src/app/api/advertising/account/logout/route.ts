import { NextResponse } from 'next/server';

import { createRouteSupabase } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

/**
 * Sign out for an ADVERTISING session (the Settings screen's Sign Out).
 * Lives under /api/advertising because the population-confined perimeter
 * 403s an advertising session everywhere else — including the operator
 * logout route. Clears the caller's own session cookies via signOut().
 */
export async function POST() {
  const sb = await createRouteSupabase();
  if (!sb) return NextResponse.json({ error: 'Auth not configured on server' }, { status: 503 });
  await sb.auth.signOut();
  return NextResponse.json({ ok: true });
}
