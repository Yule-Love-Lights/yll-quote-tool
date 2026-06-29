// Operator account management — admin-only (ledger #81 Slice 3).
//   GET  /api/admin/users  → list every operator account.
//   POST /api/admin/users  → create one { name, email, password, role } (name required).
//
// Every handler requires a real ADMIN session (requireAdmin — NOT dormancy-
// bypassed; fails closed without an admin) and uses the Supabase service-role
// admin API. The first admin is bootstrapped out-of-band via scripts/seed-admin.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { listOperatorAccounts, toOperatorAccount } from '@/lib/auth/adminUsers';
import { validateNewUser } from '@/lib/auth/accountGuards';

export const runtime = 'nodejs';

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    const users = await listOperatorAccounts(sb);
    return NextResponse.json({ users });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list accounts' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: { email?: unknown; password?: unknown; role?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const role = typeof body.role === 'string' ? body.role : 'operator';
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  const v = validateNewUser({ email, password, role, name });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no SMTP — admin-set passwords; account usable immediately
    // name lives in app_metadata (admin-only, like role) so an operator can't
    // self-spoof their attribution via the self-service password route (#81 names).
    app_metadata: { role, name },
  });
  if (error || !data?.user) {
    // Prefer the stable GoTrue error code; fall back to message text for older
    // SDKs / wording changes.
    const code = (error as { code?: string } | null)?.code;
    const dup =
      code === 'email_exists' ||
      code === 'user_already_exists' ||
      /already|exists|registered|duplicate/i.test(error?.message ?? '');
    return NextResponse.json(
      { error: error?.message ?? 'Failed to create account' },
      { status: dup ? 409 : 400 },
    );
  }
  return NextResponse.json({ user: toOperatorAccount(data.user) }, { status: 201 });
}
