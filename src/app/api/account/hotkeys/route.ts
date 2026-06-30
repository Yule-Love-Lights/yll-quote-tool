// Self-service per-account editor hotkeys (#98). GET + PUT.
//
// GET  /api/account/hotkeys           -> { hotkeys: KeyMap }  (full, defaults filled)
// PUT  /api/account/hotkeys { hotkeys } -> { ok, hotkeys }
//
// Like /api/account/password, uses the caller's OWN Supabase session
// (createRouteSupabase → auth.updateUser), NOT the service-role admin API — so it
// only ever changes the caller's own user_metadata. Hotkeys are a non-sensitive
// personal preference (no privilege, no role), so self-write is correct, and they
// follow the operator across devices (stored on their auth user). Any logged-in
// operator may set their own.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, createRouteSupabase } from '@/lib/auth/supabaseServer';
import { normalizeKeymap } from '@/components/design/editor-core/keymap';

export const runtime = 'nodejs';

export async function GET() {
  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sb = await createRouteSupabase();
  if (!sb) return NextResponse.json({ error: 'Auth not configured on server' }, { status: 503 });

  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  // Return the FULL normalized keymap (defaults filled in) so the client always
  // has every action regardless of what (if anything) was stored.
  return NextResponse.json({ hotkeys: normalizeKeymap(data.user.user_metadata?.hotkeys) });
}

export async function PUT(req: NextRequest) {
  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { hotkeys?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body.hotkeys == null || typeof body.hotkeys !== 'object') {
    return NextResponse.json({ error: 'hotkeys must be an object' }, { status: 400 });
  }

  // Sanitize hard — drop unknown ids / malformed combos, fill missing with defaults.
  const clean = normalizeKeymap(body.hotkeys);

  const sb = await createRouteSupabase();
  if (!sb) return NextResponse.json({ error: 'Auth not configured on server' }, { status: 503 });

  // Merges into user_metadata (leaves other keys, e.g. a future pref, intact).
  const { error } = await sb.auth.updateUser({ data: { hotkeys: clean } });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, hotkeys: clean });
}
