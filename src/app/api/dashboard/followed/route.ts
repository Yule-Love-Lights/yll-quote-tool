// Manually mark an inbox item as "Followed" / snoozed (#58 v2). Operator-gated.
// Stamps followed_up_at so the item hides from the open list until a newer
// inbound message clears the flag. No source write-back.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { markItemFollowed } from '@/lib/dashboard/inbox/store';
import { isUuid } from '@/lib/dashboard/inbox/validate';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-followed', limit: 60, windowMs: 60_000 });
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
  // Row 311 fix-round FIX 1: default (no opts) is allowRestamp:false — this is
  // the manual snooze button, not a send, so a retry/lost-race landing on an
  // already-followed row must not reset the customer's waiting clock. See
  // markItemFollowed's own doc comment for the full A/B caller split.
  const res = await markItemFollowed(itemId, operator?.id ?? 'system', new Date());
  if (!res.ok) {
    // The operator's goal (this item is snoozed) is already the current
    // state — an "already followed" refusal is a duplicate click or a lost
    // race against another tab, not a real failure, so treat it as an
    // idempotent success rather than surfacing a scary error note.
    if (res.alreadyFollowed) return NextResponse.json({ ok: true });
    return NextResponse.json({ error: res.error }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
