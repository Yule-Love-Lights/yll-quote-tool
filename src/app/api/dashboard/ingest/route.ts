// Generic ingest endpoint (#58 Phase 2) — a normalized JSON contract a Zapier Zap
// (Homeworks, or any future source) POSTs to. Shared-secret verified
// (DASHBOARD_INGEST_SECRET via the x-ingest-secret header). Read-only source: the
// item is created/updated here; Handled never writes back to Homeworks. Dormant
// until the secret + service-role key are set and the migration is applied.

import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/security';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rateLimitResponse } from '@/lib/rateLimit';
import { parseIngestPayload } from '@/lib/dashboard/inbox/ingest';
import { ingestTouch } from '@/lib/dashboard/inbox/store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const secret = process.env.DASHBOARD_INGEST_SECRET;
  if (!secret || !safeEqual(req.headers.get('x-ingest-secret') ?? undefined, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rl = rateLimitResponse(req, { bucket: 'dashboard-ingest', limit: 120, windowMs: 60_000 });
  if (rl) return rl;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = parseIngestPayload(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const res = await ingestTouch(parsed.touch, new Date());
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ ok: true, itemId: res.itemId, skipped: res.skipped });
}
