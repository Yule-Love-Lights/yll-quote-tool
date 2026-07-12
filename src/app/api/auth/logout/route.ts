// Operator logout (ledger #81, Option B). POST /api/auth/logout → ends the
// Supabase session, clears the SSR cookies, and clears the staff-device
// marker cookie (WT-62 — it otherwise outlives the session by up to a year).

import { NextResponse } from 'next/server';
import { createRouteSupabase } from '@/lib/auth/supabaseServer';
import { clearStaffDeviceCookie } from '@/lib/auth/staffDevice';

export const runtime = 'nodejs';

export async function POST() {
  const supabase = await createRouteSupabase();
  if (supabase) await supabase.auth.signOut();
  const res = NextResponse.json({ ok: true });
  clearStaffDeviceCookie(res);
  return res;
}
