// PII-retention sweep (ledger #90). Vercel Cron hits this GET on a schedule (see
// vercel.json); it purges ABANDONED designs — never linked to a quote and
// untouched for 90+ days — plus their private bucket images (house + satellite
// photos). LINKED designs are cleaned with their quote (deleteDesignsForQuote);
// training data is intentionally exempt (the confirmed retention policy).
//
// CRON-ONLY: Vercel attaches `Authorization: Bearer ${CRON_SECRET}` to cron
// requests — we require it, so the endpoint isn't publicly triggerable. DORMANT
// until CRON_SECRET is set. No-ops cleanly when nothing is abandoned.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { safeEqual } from '@/lib/security';
import { purgeAbandonedDesigns } from '@/lib/designs';

export const runtime = 'nodejs';

// Confirmed retention window (#90): abandoned data is kept 90 days after it was
// last touched before the sweep purges it.
const RETENTION_DAYS = 90;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const designs = await purgeAbandonedDesigns(RETENTION_DAYS);
  return NextResponse.json({ ok: true, retentionDays: RETENTION_DAYS, designs });
}
