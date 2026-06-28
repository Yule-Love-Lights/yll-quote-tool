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

  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (!isHighLevelConfigured() || !internalContactId) {
    return NextResponse.json({ ok: true, lowCount: low.length, emailed: false, note: 'email not configured' });
  }

  const nameBySku = new Map((await listCatalog()).map((c) => [c.sku, c.name]));
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
