// Quote-Tool reconcile (#58) — folds new quote leads from the shared Supabase DB
// into the inbox and maintains quote_sent_no_reply follow-ups. Vercel Cron hits
// this GET on a schedule (no Postgres trigger — a dashboard bug must never block a
// quote from saving). CRON-ONLY (Bearer ${CRON_SECRET}); dormant until set + the
// dashboard tables migration is applied.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { runQuoteToolReconcile } from '@/lib/dashboard/inbox/sync';
import { cronDenial } from '@/lib/auth/cronAuth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  // Shared guard: 503 (naming the variable) when CRON_SECRET is unset, 401 when
  // the token is merely wrong. See src/lib/auth/cronAuth.ts for why.
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const summary = await runQuoteToolReconcile(new Date());
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
