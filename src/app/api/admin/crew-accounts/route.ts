import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  crewAppMetadata,
  crewMetadataIsSafe,
  validateCrewAccount,
} from '@/lib/auth/crewAccounts';

export const runtime = 'nodejs';

/**
 * Crew login management (row 279).
 *
 *   GET  /api/admin/crew-accounts  → every crew member + whether they have a login
 *   POST /api/admin/crew-accounts  → create a login and link it to a crew member
 *
 * ADMIN ONLY, and never dormancy-bypassed: `requireAdmin` fails closed. Creating
 * a login is exactly the kind of thing that must not be reachable anonymously.
 *
 * WHY THIS ROUTE EXISTS SEPARATELY from POST /api/admin/users: that route's
 * guard hard-rejects any role outside admin/operator, which is correct and stays
 * that way. A crew login is a different population with different privileges, so
 * it gets its own door and its own guard.
 */

type CrewRow = {
  id: string;
  display_name: string;
  active: boolean;
  auth_user_id: string | null;
};

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { data, error } = await sb
    .from('crew_members')
    .select('id, display_name, active, auth_user_id')
    .order('display_name', { ascending: true });

  if (error) {
    console.error('GET /api/admin/crew-accounts:', error.message);
    return NextResponse.json({ error: 'Failed to load crew members' }, { status: 500 });
  }

  const rows = (data as unknown as CrewRow[] | null) ?? [];
  return NextResponse.json({
    crew: rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      active: r.active,
      hasLogin: r.auth_user_id !== null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = {
    crewMemberId: String(body?.crewMemberId ?? '').trim(),
    email: String(body?.email ?? '').trim(),
    password: String(body?.password ?? ''),
  };

  const guard = validateCrewAccount(input);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 400 });

  // The crew member must exist and must not already have a login: the unique
  // index would reject a second link anyway, but a clear message beats a 23505.
  const { data: existing, error: lookupError } = await sb
    .from('crew_members')
    .select('id, display_name, active, auth_user_id')
    .eq('id', input.crewMemberId)
    .maybeSingle();

  if (lookupError) {
    console.error('POST /api/admin/crew-accounts lookup:', lookupError.message);
    return NextResponse.json({ error: 'Failed to load the crew member' }, { status: 500 });
  }
  const crew = existing as unknown as CrewRow | null;
  if (!crew) return NextResponse.json({ error: 'Crew member not found' }, { status: 404 });
  if (crew.auth_user_id) {
    return NextResponse.json(
      { error: `${crew.display_name} already has a login.` },
      { status: 409 },
    );
  }

  const meta = crewAppMetadata(crew.display_name);
  // Belt and braces: refuse to create anything that would not read as crew.
  if (!crewMetadataIsSafe(meta)) {
    console.error('POST /api/admin/crew-accounts: refusing unsafe crew metadata');
    return NextResponse.json({ error: 'Internal role configuration error' }, { status: 500 });
  }

  const { data: created, error: createError } = await sb.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    app_metadata: meta,
  });

  if (createError || !created?.user) {
    const message = createError?.message ?? 'Failed to create the login';
    console.error('POST /api/admin/crew-accounts create:', message);
    // A duplicate email is the common case and is the caller's to fix.
    const conflict = /already|exists|registered/i.test(message);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }

  const authUserId = created.user.id;

  // Link it. If this fails the login would exist unlinked and unusable, so the
  // orphan auth user is deleted rather than left behind to confuse the next admin.
  const { error: linkError } = await sb
    .from('crew_members')
    .update({ auth_user_id: authUserId })
    .eq('id', crew.id)
    .is('auth_user_id', null);

  if (linkError) {
    console.error('POST /api/admin/crew-accounts link:', linkError.message);
    await sb.auth.admin.deleteUser(authUserId).catch(() => {});
    return NextResponse.json(
      { error: 'Created the login but could not link it; the login was rolled back.' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    crewMemberId: crew.id,
    displayName: crew.display_name,
    email: input.email,
    linked: true,
  });
}
