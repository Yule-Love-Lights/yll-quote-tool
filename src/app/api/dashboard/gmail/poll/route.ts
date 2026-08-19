// Gmail poll (#58) — read-only inbox ingestion for sales@. Vercel Cron hits this
// GET every 1–2 min; it reads recent inbox threads and ingests each (idempotent).
// No Gmail writes (the Handled label/mark-read is the deferred "Full write-back").
// CRON-ONLY (Bearer ${CRON_SECRET}); a soft no-op until the Gmail OAuth creds are
// set (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN/USER) and the migration is applied.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { isGmailConfigured } from '@/lib/integrations/gmail';
import { runGmailPoll } from '@/lib/dashboard/inbox/sync';
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
  // Dormant (not an error) until Gmail OAuth is set up.
  if (!isGmailConfigured()) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Gmail not configured' });
  }
  const summary = await runGmailPoll(new Date());
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
