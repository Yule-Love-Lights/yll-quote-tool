// Per-roster-entry admin operations for the text-ops bot (ledger #168) — admin-only.
//   PATCH  /api/admin/bot-users/[id]  → { displayName?, role? }  rename / change role.
//   DELETE /api/admin/bot-users/[id]  → remove from the roster.
//
// The `[id]` is the Telegram user id (all digits). Unlike operator accounts
// there is no last-admin guard here: the env TELEGRAM_ADMIN_USERS floor means an
// owner keeps bot admin access even if every DB admin row is removed, so a bad
// edit can't lock the bot's administration out.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { upsertBotUser, deleteBotUser, getBotUser, isValidTelegramId } from '@/lib/integrations/botUsers';
import type { BotRole } from '@/lib/integrations/botRoles';

export const runtime = 'nodejs';

const ROLES: BotRole[] = ['crew', 'staff', 'admin'];
const isRole = (v: unknown): v is BotRole => typeof v === 'string' && (ROLES as string[]).includes(v);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!isValidTelegramId(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: { displayName?: unknown; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const hasRole = body.role !== undefined;
  const hasName = typeof body.displayName === 'string';
  if (!hasRole && !hasName) {
    return NextResponse.json({ error: 'Nothing to update — provide role and/or displayName' }, { status: 400 });
  }
  if (hasRole && !isRole(body.role)) {
    return NextResponse.json({ error: "Role must be 'crew', 'staff', or 'admin'." }, { status: 400 });
  }
  const displayName = hasName ? (body.displayName as string).trim() : undefined;
  if (displayName !== undefined && displayName.length > 80) {
    return NextResponse.json({ error: 'Name must be 80 characters or fewer.' }, { status: 400 });
  }

  // Upsert overwrites the whole row, so read the current one and pass through
  // whichever field this PATCH didn't touch (a role-only change must not wipe
  // the name, and vice versa). Absent from the roster ⇒ 404.
  const current = await getBotUser(id);
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const user = await upsertBotUser({
      telegramUserId: id,
      role: hasRole ? (body.role as BotRole) : current.role,
      displayName: displayName !== undefined ? displayName : current.displayName,
      addedBy: auth.operator.email ?? auth.operator.id,
    });
    return NextResponse.json({ user });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update the roster entry' },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!isValidTelegramId(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const removed = await deleteBotUser(id);
    if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to remove the roster entry' },
      { status: 500 },
    );
  }
}
