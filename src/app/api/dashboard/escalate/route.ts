// Escalation engine (#58) — the anti-fall-through safety net. Vercel Cron hits
// this GET every 5–15m; it scores every open item (amber >1h, red >4h, EOD digest,
// all America/New_York), emails the whole team + sales@ (via the existing GHL
// internal-contact email transport), and self-watchdogs. Runs independent of
// anyone being logged in. CRON-ONLY (Bearer ${CRON_SECRET}); dormant until set.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { runEscalation } from '@/lib/dashboard/inbox/sync';
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
  const summary = await runEscalation(new Date());
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
