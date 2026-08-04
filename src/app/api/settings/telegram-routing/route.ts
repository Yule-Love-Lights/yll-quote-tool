// Settings → Telegram routing API. GET returns the env-allowlisted chats (each
// with a best-effort title) plus the stored routing (null = no row yet, legacy
// broadcast). PUT saves a sanitized routing. Same operator gate as
// /api/settings — these are business-wide settings, not per-user.

import { NextRequest, NextResponse } from 'next/server';
import { allowedChats, getChatTitle } from '@/lib/integrations/telegram';
import { getTelegramRouting, putTelegramRouting } from '@/lib/integrations/telegramRouting';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  try {
    const chatIds = allowedChats();
    const chats = await Promise.all(chatIds.map(async (id) => ({ id, title: await getChatTitle(id) })));
    const routing = await getTelegramRouting();
    return NextResponse.json({ chats, routing });
  } catch (err) {
    console.error('[api/settings/telegram-routing] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load Telegram routing' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a routing object' }, { status: 400 });
  }
  try {
    const routing = await putTelegramRouting(body);
    return NextResponse.json(routing);
  } catch (err) {
    console.error('[api/settings/telegram-routing] PUT failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to save' }, { status: 500 });
  }
}
