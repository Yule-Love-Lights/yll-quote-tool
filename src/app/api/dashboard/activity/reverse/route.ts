// Reverse a prior inbox-item state change (#58 v3). Operator-gated.
// Accepts { activityId } and delegates to reverseItemState() in store.ts.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { reverseItemState } from '@/lib/dashboard/inbox/store';
import { isUuid } from '@/lib/dashboard/inbox/validate';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-reverse', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { activityId } = body as { activityId?: unknown };
  if (!isUuid(activityId)) {
    return NextResponse.json({ error: 'Valid activityId (uuid) required' }, { status: 400 });
  }

  const operator = await getOperator();
  const res = await reverseItemState(activityId, operator?.id ?? 'system', new Date());
  if (!res.ok) {
    // Client-side cases (not found / not reversible / superseded) are 400; only a
    // missing service-role config is a real 503.
    const status = res.error === 'Supabase service role not configured' ? 503 : 400;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
