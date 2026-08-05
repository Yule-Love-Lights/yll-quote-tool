// src/app/api/ops/digest/route.ts
// Morning ops digest cron (Phase 1 of the 2026-07-19 text-ops plan). Vercel
// Cron hits this GET on the vercel.json schedule "30 11 * * *" — Vercel crons
// run in UTC, so that's 7:30am EDT / 6:30am EST. CRON-ONLY: same Bearer
// CRON_SECRET guard as low-stock-alert, so the endpoint isn't publicly
// triggerable. Dormant unless the Telegram bot is enabled + configured; when
// live it ALWAYS sends (the heartbeat — see opsDigest.ts), so a silent morning
// means broken, never "nothing on the board".

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

  // The heartbeat's whole promise is "a silent morning means broken". If
  // building the digest THROWS (a data read blowing up in a way that escapes
  // the collectors' fail-soft), it must NOT go silent — send a failure alert so
  // staff know the cron ran but couldn't build, and return 200 so Vercel doesn't
  // retry-storm. notifyTelegramAudience never throws, so this best-effort alert
  // can't itself cascade into a 500.
  try {
    const msg = opsDigestMessage(await collectOpsDigest(), appBaseUrl());
    await notifyTelegramAudience('ops', msg);
    return NextResponse.json({ ok: true, sent: true });
  } catch (err) {
    console.error('[ops/digest] build failed:', err);
    await notifyTelegramAudience(
      'ops',
      '⚠️ Morning digest failed to build — the cron ran but hit an error. Check the logs.',
    );
    return NextResponse.json({ ok: false, error: 'digest build failed' });
  }
}
