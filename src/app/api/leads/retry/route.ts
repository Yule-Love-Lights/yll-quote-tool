// Website-lead retry worker (#leads — GHL-outage recovery). Vercel Cron hits this
// GET on a schedule; it re-drives website_leads rows stuck 'pending'/'deferred'
// through the GHL sync (src/lib/leads/leadRetry.ts), so a lead that failed to
// sync during a GHL outage lands in the right pipeline once GHL is back. The lead
// ROW is always saved first (source of truth), so nothing is ever lost — this is
// purely the recovery pass. CRON-ONLY: requires Authorization: Bearer ${CRON_SECRET}.
// Dormant until CRON_SECRET is set.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { retryStuckLeads } from '@/lib/leads/leadRetry';
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
  const summary = await retryStuckLeads({ now: new Date() });
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
