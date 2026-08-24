// Row 342 fix round: retry a FAILED Gmail write-back for an already-Handled
// item, so a fixed Gmail token can clear the /inbox banner through the UI
// instead of only via a hand DB edit. Operator-gated, same shape as the
// sibling handled/dismiss routes.
//
// Deliberately does NOT call markItemHandledLocal — the item is already
// Handled; this only reattempts the external write-back.
// getGmailWritebackRetryTarget (store.ts) refuses any item that isn't
// CURRENTLY Handled, or whose stored handled_channel_sync doesn't say
// gmailLabel==='failed'/'unconfigured', so this can't be aimed at an
// unrelated or reopened item — see its doc comment for why re-running
// runHandledWriteback is safe (every one of its three write-back steps is
// independently idempotent: GHL mark-read, GHL tag-merge, Gmail label modify).

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getGmailWritebackRetryTarget, recordWriteback } from '@/lib/dashboard/inbox/store';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { runHandledWriteback } from '@/lib/dashboard/inbox/sync';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-handled-retry-gmail', limit: 30, windowMs: 60_000 });
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

  const retryTarget = await getGmailWritebackRetryTarget(itemId);
  if (!retryTarget.ok) return NextResponse.json({ error: retryTarget.error }, { status: 409 });

  const operator = await getOperator();
  const sync = await runHandledWriteback(retryTarget.target, operator?.email ?? operator?.id ?? 'operator');
  await recordWriteback(itemId, sync);

  return NextResponse.json({ ok: true, sync });
}
