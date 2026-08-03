// src/app/api/inventory/prep-digest/route.ts
// Daily Inventory prep digest. Vercel Cron hits this GET on the vercel.json
// schedule "0 13 * * *" — Vercel crons run in fixed UTC, so that's 9:00am EDT
// in daylight time / 8:00am EST in standard time (same DST drift as the other
// fixed-UTC crons in this file; see ops/digest's header for the same caveat).
// CRON-ONLY: same Bearer CRON_SECRET guard as the other cron routes, so the
// endpoint isn't publicly triggerable.
//
// Reports what's still waiting on the /inventory/jobs fulfillment board —
// reuses listFulfillmentCards() (the SAME function the board page's own API
// reads), so the digest and the board can never disagree. A quiet day still
// sends a one-line all-clear (prepDigestMessage never returns null).

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { isTelegramBotEnabled, isTelegramConfigured } from '@/lib/integrations/telegram';
import { notifyTelegram, appBaseUrl } from '@/lib/integrations/telegramNotify';
import { listFulfillmentCards } from '@/lib/inventory/jobs';
import { prepDigestMessage } from '@/lib/inventory/prepDigest';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  if (!isTelegramBotEnabled() || !isTelegramConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'telegram dormant' });
  }

  const cards = await listFulfillmentCards();
  const msg = prepDigestMessage(cards, appBaseUrl());
  await notifyTelegram(msg);
  return NextResponse.json({ ok: true, sent: true });
}
