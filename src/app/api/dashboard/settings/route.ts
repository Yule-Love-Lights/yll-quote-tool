// Operator-gated GET/POST for inbox configurable settings (#58 v3).
// GET  → { followUpDays }
// POST → { followUpDays: number } → { ok: true, followUpDays }

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getFollowUpDays, setFollowUpDays } from '@/lib/dashboard/inbox/settings';
import { clampFollowUpDays } from '@/lib/dashboard/inbox/lifecycle';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-settings', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  const followUpDays = await getFollowUpDays();
  return NextResponse.json({ followUpDays });
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-settings', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { followUpDays } = body as { followUpDays?: unknown };
  const days = Number(followUpDays);
  if (!Number.isFinite(days)) {
    return NextResponse.json({ error: 'followUpDays must be a finite number' }, { status: 400 });
  }

  await setFollowUpDays(days);
  return NextResponse.json({ ok: true, followUpDays: clampFollowUpDays(days) });
}
