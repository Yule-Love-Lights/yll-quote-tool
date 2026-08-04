// src/app/api/ops/digest/route.ts
// Morning ops digest cron (Phase 1 of the 2026-07-19 text-ops plan). Vercel
// Cron hits this GET on the vercel.json schedule "30 11 * * *" — Vercel crons
// run in UTC, so that's 7:30am EDT / 6:30am EST. CRON-ONLY: same Bearer
// CRON_SECRET guard as low-stock-alert, so the endpoint isn't publicly
// triggerable. Dormant unless the Telegram bot is enabled + configured, and an
// all-quiet day sends nothing (opsDigestMessage returns null).

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isTelegramBotEnabled, isTelegramConfigured } from '@/lib/integrations/telegram';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';
import { collectOpsDigest, opsDigestMessage } from '@/lib/integrations/opsDigest';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isTelegramBotEnabled() || !isTelegramConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'telegram dormant' });
  }

  const msg = opsDigestMessage(await collectOpsDigest(), appBaseUrl());
  if (!msg) return NextResponse.json({ ok: true, sent: false });

  await notifyTelegramAudience('ops', msg);
  return NextResponse.json({ ok: true, sent: true });
}
