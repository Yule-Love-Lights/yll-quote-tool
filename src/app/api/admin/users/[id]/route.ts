// Per-account admin operations (ledger #81 Slice 3) — admin-only.
//   PATCH  /api/admin/users/[id]  → { password?, role? }  reset password / change role.
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
import { requireAdmin, roleOf, type OperatorRole } from '@/lib/auth/supabaseServer';
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

  let body: { password?: unknown; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const newPassword = typeof body.password === 'string' ? body.password : undefined;
  const newRole = typeof body.role === 'string' ? body.role : undefined;

  if (newPassword === undefined && newRole === undefined) {
    return NextResponse.json({ error: 'Nothing to update — provide password and/or role' }, { status: 400 });
  }
  if (newPassword !== undefined && newPassword.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }
  if (newRole !== undefined && newRole !== 'admin' && newRole !== 'operator') {
    return NextResponse.json({ error: "Role must be 'admin' or 'operator'" }, { status: 400 });
  }

  try {
    const { data: target, error: getErr } = await sb.auth.admin.getUserById(id);
    if (getErr || !target?.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
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
