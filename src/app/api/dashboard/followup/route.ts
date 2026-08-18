// Mark a follow-up done (#58). Operator-gated. Used by the "due today" strip's
// Done button.
//
// #252 slice E: when the follow-up is anchored to an inbox item (inbox_item_id
// non-null) that's still 'unresponded', ALSO resolve that item through the
// same Handled machinery /api/dashboard/handled uses (markItemHandledLocal +
// runHandledWriteback + recordWriteback) — see shouldResolveAnchoredItem's doc
// comment (store.ts) for the full rationale. An item that's already
// handled/completed/dismissed is left untouched (the gate checks real status,
// not just "not handled"). Best-effort: any failure in this second half is
// swallowed — it never fails the follow-up Done action itself.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { markFollowUpDone, getItemStatus, markItemHandledLocal, recordWriteback, shouldResolveAnchoredItem } from '@/lib/dashboard/inbox/store';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { runHandledWriteback } from '@/lib/dashboard/inbox/sync';

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
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Valid id (uuid) required' }, { status: 400 });
  }

  const operator = await getOperator();
  const res = await markFollowUpDone(id, operator?.id ?? null);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 503 });

  if (res.inboxItemId) {
    try {
      const itemStatus = await getItemStatus(res.inboxItemId);
      if (shouldResolveAnchoredItem('done', itemStatus)) {
        const local = await markItemHandledLocal(res.inboxItemId, operator?.id ?? null, new Date());
        if (local.ok) {
          const sync = await runHandledWriteback(local.target, operator?.email ?? operator?.id ?? 'operator');
          await recordWriteback(res.inboxItemId, sync);
        }
      }
    } catch (e) {
      console.warn('[api/dashboard/followup] anchored item resolve failed (non-fatal):', e);
    }
  }

  return NextResponse.json({ ok: true });
}
