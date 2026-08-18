// Dismiss an inbox item as "not a lead" (#58). Operator-gated. Sets status
// 'dismissed' (sticky — the reducer keeps it dismissed on future touches) so spam
// never re-surfaces or escalates. No source write-back.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { dismissItem } from '@/lib/dashboard/inbox/store';
import { isUuid } from '@/lib/dashboard/inbox/validate';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-dismiss', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { itemId } = body as { itemId?: unknown };
  if (!isUuid(itemId)) {
    return NextResponse.json({ error: 'Valid itemId (uuid) required' }, { status: 400 });
  }

  const operator = await getOperator();
  // handled_by is a uuid FK (auth.users) — NULL, never the string 'system', on
  // the narrow path where the auth gate is dormant and no operator resolved.
  const res = await dismissItem(itemId, operator?.id ?? null, new Date());
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 503 });
  return NextResponse.json({ ok: true });
}
