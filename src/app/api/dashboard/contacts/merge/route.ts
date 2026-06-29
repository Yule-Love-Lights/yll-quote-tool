// Merge two duplicate contacts (#58 Phase 1.5). Operator-gated. The operator picks
// which contact survives (primaryId); the other (secondaryId) is merged in and
// deleted, its items + follow-ups repointed. Never auto-merged — this is the
// by-hand resolution for the ambiguous dupes identity resolution refused to join.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { mergeContactsById } from '@/lib/dashboard/inbox/store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-merge', limit: 30, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { primaryId, secondaryId } = body as { primaryId?: unknown; secondaryId?: unknown };
  if (typeof primaryId !== 'string' || !primaryId || typeof secondaryId !== 'string' || !secondaryId) {
    return NextResponse.json({ error: 'primaryId and secondaryId required' }, { status: 400 });
  }

  const operator = await getOperator();
  const res = await mergeContactsById(primaryId, secondaryId, operator?.id ?? 'system');
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
