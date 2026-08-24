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
  // Row 387: every surface that renders Dismiss (InboxList, InWorksSection) is
  // fed by the needs_reply / awaiting_reply / handled buckets, and
  // applyBucketFilter excludes completed/dismissed from all three by
  // construction — so those two are the only statuses an operator can legally
  // dismiss FROM. Passing them swaps dismissItem's negative
  // `.neq('status','dismissed')` default (which a row that moved to
  // 'handled'/'completed' sails straight through, flipping an answered lead to
  // dismissed AND suppressing that customer's future messages) for a positive
  // CAS. Same set /api/dashboard/reply passes, for the same reason.
  const res = await dismissItem(itemId, operator?.id ?? null, new Date(), {
    expectedStatus: ['unresponded', 'handled'],
  });
  // 409, not 503: `refused` means the CAS matched zero rows — real evidence the
  // item moved on (another operator resolved it, or an auto-complete tick did),
  // not a backend failure. The client already renders the route's own error text
  // for a non-ok response and refreshes the row, so this surfaces as "someone
  // else already dealt with this" rather than a generic failure.
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.refused ? 409 : 503 });
  return NextResponse.json({ ok: true });
}
