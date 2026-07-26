// Text-ops bot roster management — admin-only (ledger #168).
//   GET  /api/admin/bot-users  → list the bot roster.
//   POST /api/admin/bot-users  → add/update one { telegramUserId, displayName?, role }.
//
// Every handler requires a real ADMIN session (requireAdmin — fails closed
// without an admin). The bot itself reads this roster on each message via
// resolveSenderRole; the env TELEGRAM_*_USERS lists remain a lockout-proof floor.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listBotUsers, upsertBotUser, isValidTelegramId } from '@/lib/integrations/botUsers';
import type { BotRole } from '@/lib/integrations/botRoles';

export const runtime = 'nodejs';

const ROLES: BotRole[] = ['crew', 'staff', 'admin'];
const isRole = (v: unknown): v is BotRole => typeof v === 'string' && (ROLES as string[]).includes(v);

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json({ users: await listBotUsers() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list the roster' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: { telegramUserId?: unknown; displayName?: unknown; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  // `JSON.parse('null')` succeeds, so a literal null body slips past the catch and
  // would throw on the first property read below. Reject non-objects up front.
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const telegramUserId = typeof body.telegramUserId === 'string' ? body.telegramUserId.trim() : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : null;
  const role = body.role;

  if (!isValidTelegramId(telegramUserId)) {
    return NextResponse.json(
      { error: 'Enter the numeric Telegram user id (all digits).' },
      { status: 400 },
    );
  }
  if (!isRole(role)) {
    return NextResponse.json({ error: "Role must be 'crew', 'staff', or 'admin'." }, { status: 400 });
  }
  if (displayName && displayName.length > 80) {
    return NextResponse.json({ error: 'Name must be 80 characters or fewer.' }, { status: 400 });
  }

  try {
    const user = await upsertBotUser({
      telegramUserId,
      displayName,
      role,
      addedBy: auth.operator.email ?? auth.operator.id,
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save the roster entry' },
      { status: 500 },
    );
  }
}
