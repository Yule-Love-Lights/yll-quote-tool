// Mark a follow-up done (#58). Operator-gated. Used by the "due today" strip's
// Done button.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { markFollowUpDone } from '@/lib/dashboard/inbox/store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-followup', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { id } = body as { id?: unknown };
  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const operator = await getOperator();
  const res = await markFollowUpDone(id, operator?.id ?? 'operator');
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 503 });
  return NextResponse.json({ ok: true });
}
