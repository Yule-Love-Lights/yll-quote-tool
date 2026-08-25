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
  // Row 387: 'unresponded' is the ONLY status an operator can legally dismiss
  // FROM. The single Dismiss control in the app is InboxList's "Not a lead"
  // (InboxList.tsx), and that list is fed by listOpenItems, which applies
  // applyBucketFilter(..., 'needs_reply') — `status = 'unresponded'` AND
  // `followed_up_at IS NULL`. InWorksSection renders no dismiss control at all.
  //
  // FIX ROUND (two lenses converged on this independently): the first cut passed
  // ['unresponded','handled'], derived from which buckets EXIST rather than from
  // which bucket actually feeds the button — and 'handled' is precisely the
  // status this guard exists to REFUSE. A row that a colleague answered in the
  // read→write gap is 'handled', so allowing it let the stale click through and
  // reopened the very race the row is about: an answered lead flipped to
  // dismissed, and addSuppressedSenders silently filtering that real customer's
  // future messages. Single value, matching /api/dashboard/handled exactly.
  const res = await dismissItem(itemId, operator?.id ?? null, new Date(), {
    expectedStatus: 'unresponded',
  });
  // 409, not 503: `refused` means the CAS matched zero rows — real evidence the
  // item moved on (another operator answered/completed it), not a backend
  // failure, so the client can tell a lost race from an outage.
  //
  // Row 392 (fixed — this comment used to describe a known cosmetic gap): a
  // real refusal means the row has by definition left the needs_reply
  // bucket, so act()'s refresh() would silently drop it and orphan its error
  // note — the operator would see the row vanish, indistinguishable from
  // success, and could believe the sender was suppressed when it deliberately
  // was not (the refusal is CORRECT: a colleague answered it, so it IS a real
  // lead and must not be suppressed). Closed the same way row 287 closed it
  // for reply: InboxList.tsx's act() now checks isRefusalStatus(res.status)
  // — on this exact 409 it restores the row and keeps its note visible
  // (refusedIds) until the operator dismisses it, instead of letting
  // refresh() erase it.
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.refused ? 409 : 503 });
  return NextResponse.json({ ok: true });
}
