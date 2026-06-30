// GHL "Customer Replied" webhook (#58) — low-latency trigger. A single GHL
// workflow (Send Webhook) POSTs here with a shared secret header; we don't depend
// on the exact payload shape — we just run a bounded reconcile (the conversation
// that changed is among the newest the search returns). The 60s reconcile cron is
// the backstop if this is ever misconfigured or down.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { runGhlReconcile } from '@/lib/dashboard/inbox/sync';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const secret = process.env.DASHBOARD_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.headers.get('x-dashboard-secret') ?? undefined, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rl = rateLimitResponse(req, { bucket: 'dashboard-ghl-webhook', limit: 120, windowMs: 60_000 });
  if (rl) return rl;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const summary = await runGhlReconcile(new Date(), { limit: 20 });
  return NextResponse.json({ ok: true, summary });
}
