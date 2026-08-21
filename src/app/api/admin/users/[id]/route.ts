// Per-account admin operations (ledger #81 Slice 3) — admin-only.
//   PATCH  /api/admin/users/[id]  → { password?, role?, name? }  reset pw / change role / set name.
//   DELETE /api/admin/users/[id]  → remove the account.
//
// Guards (src/lib/auth/accountGuards.ts): an admin can't change their OWN role,
// can't delete themselves, and can't delete or demote the LAST admin. The
// last-admin guard is a point-in-time count (not transactional), so two admins
// acting concurrently against each other could in theory reach zero admins — a
// rare race recoverable with `npm run seed-admin` (the documented bootstrap).
//
// The `:id` is validated as a UUID up front: the Supabase admin SDK throws
// (outside its own try/catch) on a non-UUID, so an unvalidated id would surface
// as a 500 leaking the library name instead of a clean 404.

import { NextRequest, NextResponse } from 'next/server';
import { isCrewAccount, requireAdmin, roleOf, type OperatorRole } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { listOperatorAccounts, countAdmins, toOperatorAccount } from '@/lib/auth/adminUsers';
import { canChangeRole, canDeleteUser } from '@/lib/auth/accountGuards';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  let body: { password?: unknown; role?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const newPassword = typeof body.password === 'string' ? body.password : undefined;
  const newRole = typeof body.role === 'string' ? body.role : undefined;
  // A name key that's PRESENT (even blank) is an intent to set it → validate.
  // Absent → newName undefined → name left untouched, so a password/role-only edit
  // on a legacy (nameless) account still works. This is the backfill/rename path.
  const newName = typeof body.name === 'string' ? body.name.trim() : undefined;

  if (newPassword === undefined && newRole === undefined && newName === undefined) {
    return NextResponse.json(
      { error: 'Nothing to update — provide password, role, and/or name' },
      { status: 400 },
    );
  }
  if (newPassword !== undefined && newPassword.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }
  if (newRole !== undefined && newRole !== 'admin' && newRole !== 'operator') {
    return NextResponse.json({ error: "Role must be 'admin' or 'operator'" }, { status: 400 });
  }
  if (typeof body.name === 'string') {
    if (!newName) return NextResponse.json({ error: 'A name is required' }, { status: 400 });
    if (newName.length > 80) {
      return NextResponse.json({ error: 'Name must be 80 characters or fewer' }, { status: 400 });
    }
  }

  try {
    const { data: target, error: getErr } = await sb.auth.admin.getUserById(id);
    if (getErr || !target?.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    // ⚠️ CREW LOGINS ARE NOT MANAGEABLE THROUGH THIS DOOR.
    //
    // Crew and operators share one auth store (row 279), and `roleOf` collapses
    // ANY non-admin role — including 'crew' — to 'operator'. Without this check
    // a PATCH of { role: 'admin' } read the target as an operator, passed
    // canChangeRole, and then overwrote the `role: 'crew'` marker via the
    // spread below. The account became a real admin with access to /customers
    // and every PII surface, while crew_members.auth_user_id still pointed at
    // it as someone's pay identity. Found by the S58 wrap review's security
    // lens; there was no test covering a crew target here.
    if (isCrewAccount(target.user.app_metadata)) {
      return NextResponse.json(
        { error: 'This is a crew login. Manage it under Settings → Accounts → Crew logins.' },
        { status: 403 },
      );
    }

    const currentRole = roleOf(target.user.app_metadata);

    const updates: { password?: string; app_metadata?: Record<string, unknown> } = {};
    if (newPassword !== undefined) updates.password = newPassword;
    if (newRole !== undefined && newRole !== currentRole) {
      const accounts = await listOperatorAccounts(sb);
      const g = canChangeRole({
        callerId: auth.operator.id,
        targetId: id,
        currentRole,
        newRole: newRole as OperatorRole,
        adminCount: countAdmins(accounts),
      });
      if (!g.ok) return NextResponse.json({ error: g.error }, { status: 400 });
      updates.app_metadata = { ...(target.user.app_metadata ?? {}), role: newRole };
    }
    // Name merge — AFTER the role merge so a combined name+role PATCH preserves
    // both. Builds on updates.app_metadata when role also changed this call, else
    // on the target's existing metadata (the legacy-backfill path).
    if (newName !== undefined) {
      updates.app_metadata = {
        ...(updates.app_metadata ?? target.user.app_metadata ?? {}),
        name: newName,
      };
    }

    const { data: updated, error: updErr } = await sb.auth.admin.updateUserById(id, updates);
    if (updErr || !updated?.user) {
      return NextResponse.json({ error: updErr?.message ?? 'Failed to update account' }, { status: 500 });
    }
    return NextResponse.json({ user: toOperatorAccount(updated.user) });
  } catch {
    return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  try {
    const { data: target, error: getErr } = await sb.auth.admin.getUserById(id);
    if (getErr || !target?.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    // ⚠️ SAME DOOR, SAME REFUSAL AS PATCH ABOVE — see that comment for why
    // `roleOf` cannot be trusted to spot a crew login here either.
    //
    // DELETE needs the guard for a SECOND reason PATCH does not have:
    // `crew_members.auth_user_id` has no foreign key to `auth.users`, so
    // deleting the auth user here does NOT clear the pointer. The column keeps
    // a dangling id, `GET /api/admin/crew-accounts` still reports
    // `hasLogin: true` for that person, and `POST /api/admin/crew-accounts`
    // refuses to mint a replacement with a 409 because it only tests the column
    // for truthiness — never whether the id still resolves. That crew member is
    // then locked out permanently, recoverable only by a manual SQL UPDATE.
    // Crew rows render as a plain "operator" in the accounts table, so this was
    // one routine "remove the operator who never signed in" click away.
    if (isCrewAccount(target.user.app_metadata)) {
      return NextResponse.json(
        { error: 'This is a crew login. Manage it under Settings → Accounts → Crew logins.' },
        { status: 403 },
      );
    }

    const targetRole = roleOf(target.user.app_metadata);
    const accounts = await listOperatorAccounts(sb);
    const g = canDeleteUser({
      callerId: auth.operator.id,
      targetId: id,
      targetRole,
      adminCount: countAdmins(accounts),
    });
    if (!g.ok) return NextResponse.json({ error: g.error }, { status: 400 });

    const { error: delErr } = await sb.auth.admin.deleteUser(id);
    if (delErr) return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
    return NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}
