// Escalation engine (#58) — the anti-fall-through safety net. Vercel Cron hits
// this GET every 5–15m; it scores every open item (amber >1h, red >4h, EOD digest,
// all America/New_York), emails the whole team + sales@ (via the existing GHL
// internal-contact email transport), and self-watchdogs. Runs independent of
// anyone being logged in. CRON-ONLY (Bearer ${CRON_SECRET}); dormant until set.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { runEscalation } from '@/lib/dashboard/inbox/sync';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const summary = await runEscalation(new Date());
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
