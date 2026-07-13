// Operator logout (ledger #81, Option B). POST /api/auth/logout → ends the
// Supabase session, clears the SSR cookies, and unmarks this browser as a
// staff device (WT-62) so a repurposed device stops suppressing a real
// customer's own view signals.

import { NextResponse } from 'next/server';
import { createRouteSupabase } from '@/lib/auth/supabaseServer';
import { STAFF_DEVICE_COOKIE } from '@/lib/auth/staffDevice';

export const runtime = 'nodejs';

export async function POST() {
  const supabase = await createRouteSupabase();
  if (supabase) await supabase.auth.signOut();
  const res = NextResponse.json({ ok: true });
  // Overwrite with the same attributes used to set it (mark-device/route.ts)
  // so the browser recognizes it as the same cookie and expires it now.
  res.cookies.set(STAFF_DEVICE_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return res;
}
