// GHL reconcile — the safety-net poll (#58). Vercel Cron hits this GET on a
// schedule; it pulls recent conversations and ingests each idempotently, so a
// lead surfaces even if the "Customer Replied" webhook is down. CRON-ONLY:
// requires Authorization: Bearer ${CRON_SECRET}. Dormant until CRON_SECRET is set
// and the dashboard tables migration is applied.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { runGhlReconcile } from '@/lib/dashboard/inbox/sync';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const summary = await runGhlReconcile(new Date());
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
