// Mark an inbox item Handled (#58). Operator-gated. Mirrors the quotes/[id]/send
// pattern: stamp the local handled-state + handler FIRST (attribution never
// depends on the external call), then best-effort write back to the source and
// persist the per-channel outcome.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { markItemHandledLocal, recordWriteback } from '@/lib/dashboard/inbox/store';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { runHandledWriteback } from '@/lib/dashboard/inbox/sync';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-handled', limit: 60, windowMs: 60_000 });
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
  const now = new Date();

  // 1. Stamp local first — instant + authoritative, even if GHL is down.
  // handled_by is a uuid FK (auth.users) — NULL, never the string 'system',
  // on the narrow path where the auth gate is dormant and no operator resolved.
  //
  // Row 320(c): this button only ever renders on a listOpenItems row (bucket
  // 'needs_reply', status==='unresponded' — see InboxList.tsx / store.ts's
  // applyBucketFilter). A stale click racing a concurrent Mark-completed/
  // Dismiss on the same item must be refused, not resurrect the terminal row
  // — expectedStatus carries that positive expectation into the write's own
  // CAS instead of the negative `.neq('status','handled')` default, which
  // would have let it through.
  const local = await markItemHandledLocal(itemId, operator?.id ?? null, now, { expectedStatus: 'unresponded' });
  if (!local.ok) return NextResponse.json({ error: local.error }, { status: 409 });

  // 2. Best-effort source write-back: GHL mark-read + handled-by tag + ensure the
  //    pipeline opportunity, and the Gmail YLL/Handled label. Each step is caught
  //    independently and its outcome persisted. NOTE: whether GHL mark-read clears
  //    the conversation unread badge is UNVERIFIED pending a human-watched live
  //    test (see the spike + memory).
  const sync = await runHandledWriteback(local.target, operator?.email ?? operator?.id ?? 'operator');
  await recordWriteback(itemId, sync);

  return NextResponse.json({ ok: true, sync });
}
