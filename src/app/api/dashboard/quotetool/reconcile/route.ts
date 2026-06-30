// Quote-Tool reconcile (#58) — folds new quote leads from the shared Supabase DB
// into the inbox and maintains quote_sent_no_reply follow-ups. Vercel Cron hits
// this GET on a schedule (no Postgres trigger — a dashboard bug must never block a
// quote from saving). CRON-ONLY (Bearer ${CRON_SECRET}); dormant until set + the
// dashboard tables migration is applied.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { runQuoteToolReconcile } from '@/lib/dashboard/inbox/sync';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const summary = await runQuoteToolReconcile(new Date());
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
