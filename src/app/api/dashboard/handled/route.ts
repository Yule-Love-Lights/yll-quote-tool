// Mark an inbox item Handled (#58). Operator-gated. Mirrors the quotes/[id]/send
// pattern: stamp the local handled-state + handler FIRST (attribution never
// depends on the external call), then best-effort write back to the source and
// persist the per-channel outcome.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { markItemHandledLocal, recordWriteback } from '@/lib/dashboard/inbox/store';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { markConversationRead } from '@/lib/integrations/highlevel';

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
  const local = await markItemHandledLocal(itemId, operator?.id ?? 'system', now);
  if (!local.ok) return NextResponse.json({ error: local.error }, { status: 409 });

  // 2. Best-effort source write-back. GHL: mark the conversation read.
  //    NOTE: whether mark-read clears the conversation unread badge is UNVERIFIED
  //    pending a human-watched live test — see the spike + memory. TODO(#58):
  //    ensure/advance the opportunity + handled-by tag, and Gmail label write-back.
  const t = local.target;
  const sync: Record<string, unknown> = {};
  if (t.source === 'ghl' && t.externalId && t.sourceMessageId) {
    try {
      await markConversationRead(t.externalId, t.sourceMessageId);
      sync.ghlMarkRead = 'ok';
    } catch (err) {
      sync.ghlMarkRead = 'failed';
      sync.ghlError = err instanceof Error ? err.message : String(err);
    }
  }
  await recordWriteback(itemId, sync);

  return NextResponse.json({ ok: true, sync });
}
