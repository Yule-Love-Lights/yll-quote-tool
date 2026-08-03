// src/app/api/inventory/low-stock-alert/route.ts
// Daily low-stock alarm (#82 stock loop). Vercel Cron hits this GET on a schedule
// (see vercel.json); it emails staff/purchasing a digest of SKUs at/below their
// reorder point. CRON-ONLY: Vercel attaches `Authorization: Bearer ${CRON_SECRET}`
// to cron requests — we require it, so the endpoint isn't publicly triggerable.
// DORMANT until CRON_SECRET is set. No-ops cleanly when nothing is low.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { safeEqual } from '@/lib/security';
import { listOnHand } from '@/lib/inventory/onHand';
import { listCatalog } from '@/lib/inventory/catalog';
import { lowStockItems } from '@/lib/inventory/lowStock';
import { isHighLevelConfigured, sendEmail } from '@/lib/integrations/highlevel';
import { lowStockEmailSubject, lowStockEmailHtml } from '@/lib/integrations/quoteMessages';
import { isTelegramBotEnabled, isTelegramConfigured } from '@/lib/integrations/telegram';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';
import { lowStockMessage } from '@/lib/integrations/telegramMessages';
import { newlyLowSkus, getLastLowStockNotified, recordLowStockNotified } from '@/lib/inventory/lowStockNotify';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const low = lowStockItems(await listOnHand());
  if (!low.length) return NextResponse.json({ ok: true, lowCount: 0, emailed: false });

  const nameBySku = new Map((await listCatalog()).map((c) => [c.sku, c.name]));

  // #82 follow-up — proactive Telegram ping for SKUs that NEWLY went low. Runs
  // independently of the email below; gated on the bot being live so the dedup
  // baseline isn't consumed while the bot is off (enabling it gives one catch-up
  // ping of what's currently low, then steady-state new-only). Best-effort.
  try {
    if (isTelegramBotEnabled() && isTelegramConfigured()) {
      const currentLow = low.map((l) => l.sku);
      const newly = new Set(newlyLowSkus(currentLow, await getLastLowStockNotified()));
      if (newly.size) {
        await notifyTelegramAudience(
          'inventory',
          lowStockMessage({
            items: low
              .filter((l) => newly.has(l.sku))
              .map((l) => ({
                name: nameBySku.get(l.sku) ?? '(not in catalog)',
                sku: l.sku,
                onHand: l.onHand,
                reorderPoint: l.reorderPoint,
              })),
            baseUrl: appBaseUrl(),
          }),
        );
      }
      await recordLowStockNotified(currentLow);
    }
  } catch (err) {
    console.error('[api/inventory/low-stock-alert] telegram ping failed:', err);
  }

  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (!isHighLevelConfigured() || !internalContactId) {
    return NextResponse.json({ ok: true, lowCount: low.length, emailed: false, note: 'email not configured' });
  }

  try {
    await sendEmail({
      contactId: internalContactId,
      subject: lowStockEmailSubject(low.length),
      html: lowStockEmailHtml(low.map((l) => ({ ...l, name: nameBySku.get(l.sku) ?? '(not in catalog)' }))),
      emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
    });
    return NextResponse.json({ ok: true, lowCount: low.length, emailed: true });
  } catch (err) {
    console.error('[api/inventory/low-stock-alert] send failed:', err);
    return NextResponse.json({ error: 'Failed to send low-stock alert' }, { status: 502 });
  }
}
