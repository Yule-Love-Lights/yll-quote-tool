// Send a reply to an inbox item via GHL (SMS or Email), then mark it handled
// (#58 v2). Operator-gated. The route resolves the send target, sends via
// GHL, and stamps the local handled state + source write-back in one call.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { getItemForReply, markItemFollowed, markItemHandledLocal, recordWriteback } from '@/lib/dashboard/inbox/store';
import { resolveReplyTarget } from '@/lib/dashboard/inbox/reply';
import { sendSms, sendEmail } from '@/lib/integrations/highlevel';
import { runHandledWriteback } from '@/lib/dashboard/inbox/sync';
import { getSupabaseServiceClient } from '@/lib/supabase';

export const runtime = 'nodejs';

// Double-submit guard (dashboard-reply-double-submit): a network retry or a
// stale second operator tab can both fire this real GHL SMS/email send —
// client-side `sendBusy` doesn't stop either. Before sending, atomically claim
// the item (conditional UPDATE, same idiom as markItemHandledLocal's
// `.neq('status','handled')` guard in store.ts): a request landing while a
// prior claim is still fresh gets 0 rows back and is rejected as a duplicate
// BEFORE any send fires. Long enough to absorb a retry + the GHL round-trip;
// short enough that a genuinely new reply a bit later isn't blocked.
const REPLY_CLAIM_WINDOW_MS = 20_000;

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rl = rateLimitResponse(req, { bucket: 'dashboard-reply', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { itemId, text, channel } = body as { itemId?: unknown; text?: unknown; channel?: unknown };
  if (!isUuid(itemId)) {
    return NextResponse.json({ error: 'Valid itemId (uuid) required' }, { status: 400 });
  }
  if (typeof text !== 'string' || !text.trim()) {
    return NextResponse.json({ error: 'Message text required' }, { status: 400 });
  }
  const chosen = channel === 'sms' || channel === 'email' ? channel : undefined;

  const item = await getItemForReply(itemId);
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

  const target = resolveReplyTarget(item, chosen);
  if (target.kind !== 'send') {
    return NextResponse.json({ error: target.reason }, { status: 400 });
  }

  // Atomic pre-send claim. Fail OPEN on a claim-layer error (e.g. the column
  // isn't migrated yet) — the guard must never block a legitimate send.
  const sb = getSupabaseServiceClient();
  if (sb) {
    const cutoffIso = new Date(Date.now() - REPLY_CLAIM_WINDOW_MS).toISOString();
    const { data: claimed, error: claimErr } = await sb
      .from('inbox_items')
      .update({ reply_claimed_at: new Date().toISOString() })
      .eq('id', itemId)
      .or(`reply_claimed_at.is.null,reply_claimed_at.lt.${cutoffIso}`)
      .select('id')
      .maybeSingle();
    if (claimErr) {
      console.warn('[api/dashboard/reply] duplicate-send guard check failed (continuing):', claimErr.message);
    } else if (!claimed) {
      return NextResponse.json(
        { error: 'A reply for this item was just sent — wait a moment before retrying.' },
        { status: 409 },
      );
    }
  }

  try {
    if (target.via === 'sms') {
      await sendSms({
        contactId: target.contactId,
        message: text.trim(),
        fromNumber: process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined,
      });
    } else {
      const html = text
        .trim()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      await sendEmail({
        contactId: target.contactId,
        subject: 'Re: your Yule Love Lights inquiry',
        html,
        emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
      });
    }
  } catch (e) {
    // Release the claim: a genuine send failure must not block a legitimate
    // retry for the rest of the dedupe window.
    if (sb) await sb.from('inbox_items').update({ reply_claimed_at: null }).eq('id', itemId);
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 200) : 'Send failed' },
      { status: 502 },
    );
  }

  // Stamp handled locally first (attribution never depends on the write-back).
  const local = await markItemHandledLocal(itemId, operator.id, new Date());
  if (local.ok) {
    const sync = await runHandledWriteback(local.target, operator.email ?? operator.id);
    await recordWriteback(itemId, sync);
  }

  // Sent in-tool → snooze as "Followed" (awaiting their reply). Best-effort: a
  // failure here must not unsend or fail the request.
  await markItemFollowed(itemId, operator.id, new Date());

  return NextResponse.json({ ok: true });
}
