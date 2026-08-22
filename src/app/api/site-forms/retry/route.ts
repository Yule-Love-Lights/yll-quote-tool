// Site-submission retry worker (#195). Vercel Cron hits this GET on a schedule
// and re-drives submissions whose GHL contact sync never landed, so a newsletter
// signup or job application that hit a GHL outage still gets its contact and tag
// once GHL is back. The submission ROW is always saved first, so this is purely
// the recovery pass and nothing is ever lost either way.
//
// CRON-ONLY: requires Authorization: Bearer ${CRON_SECRET}. Dormant until
// CRON_SECRET is set. Same shape as /api/leads/retry.
//
// NOTE for the auth perimeter: this path must be in the operatorGate allowlist,
// because a cron request carries no operator session and would otherwise be
// 401'd before it ever reached the CRON_SECRET check below. That exact gap
// silently disabled three other crons in the past.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { retryStuckSubmissions } from '@/lib/siteForms/siteFormRetry';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? undefined, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const summary = await retryStuckSubmissions({ now: new Date() });
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
