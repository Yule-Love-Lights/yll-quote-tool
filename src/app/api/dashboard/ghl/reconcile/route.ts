// GHL reconcile — the safety-net poll (#58). Vercel Cron hits this GET on a
// schedule; it pulls recent conversations and ingests each idempotently, so a
// lead surfaces even if the "Customer Replied" webhook is down. CRON-ONLY:
// requires Authorization: Bearer ${CRON_SECRET}. Dormant until CRON_SECRET is set
// and the dashboard tables migration is applied.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { runGhlReconcile } from '@/lib/dashboard/inbox/sync';
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
  const summary = await runGhlReconcile(new Date());
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
