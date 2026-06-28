// Operator logout (ledger #81, Option B). POST /api/auth/logout → ends the
// Supabase session and clears the SSR cookies.

import { NextResponse } from 'next/server';
import { createRouteSupabase } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function POST() {
  const supabase = await createRouteSupabase();
  if (supabase) await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
