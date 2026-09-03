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
  const { itemId, again } = body as { itemId?: unknown; again?: unknown };
  if (!isUuid(itemId)) {
    return NextResponse.json({ error: 'Valid itemId (uuid) required' }, { status: 400 });
  }

  const operator = await getOperator();
  // Row 311 fix-round FIX 1: default (no opts) is allowRestamp:false — this is
  // the manual snooze button, not a send, so a retry/lost-race landing on an
  // already-followed row must not reset the customer's waiting clock. See
  // markItemFollowed's own doc comment for the full A/B caller split.
  // `again` is the re-chase button on an ALREADY-followed row (the "In the
  // works" awaiting list). Without it that click is a silent no-op: the store
  // refuses a second stamp, this route turns the refusal into a 200, and the
  // row never moves — so a staffer who phones somebody has no way to reset the
  // quiet counter. Explicitly opt-in, and only for a real boolean, so the
  // default stays the safe non-restamping one described below.
  //
  // The trade this accepts: a retried "Followed again" click restamps a second
  // time. It moves the customer's waiting clock by the seconds between the two
  // clicks, which is not the harm allowRestamp:false exists to prevent (that
  // one is a stale retry landing days later and wiping a real wait).
  const res = await markItemFollowed(itemId, operator?.id ?? 'system', new Date(), {
    allowRestamp: again === true,
  });
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
