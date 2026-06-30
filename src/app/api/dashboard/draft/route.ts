// AI-draft a reply for an inbox item (#58 v2). Operator-gated. Gathers the
// recent GHL conversation thread, builds a prompt, calls Claude, and returns
// the draft text for the operator to review + edit before sending.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { isUuid } from '@/lib/dashboard/inbox/validate';
import { getClaudeClient } from '@/lib/claude';
import { getItemForReply } from '@/lib/dashboard/inbox/store';
import { getConversationMessages } from '@/lib/integrations/highlevel';
import { buildDraftPrompt, type DraftContext } from '@/lib/dashboard/inbox/draft';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  // Secondary operator check (defense in depth, matches handled/dismiss pattern).
  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rl = rateLimitResponse(req, { bucket: 'dashboard-draft', limit: 30, windowMs: 60_000 });
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

  const client = getClaudeClient();
  if (!client) return NextResponse.json({ error: 'AI drafting not configured' }, { status: 503 });

  const item = await getItemForReply(itemId);
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

  let recentMessages: DraftContext['recentMessages'] = [];
  if (item.source === 'ghl') {
    try {
      const { messages } = await getConversationMessages(item.externalId);
      // GHL returns messages newest-first; sort oldest→newest so the prompt's
      // "Recent conversation (oldest first)" holds and slice(-8) keeps the
      // LATEST eight (the customer's most recent message ends the thread).
      recentMessages = [...messages]
        .sort((a, b) => (a.dateAdded ?? '').localeCompare(b.dateAdded ?? ''))
        .slice(-8)
        .map((m) => ({
          fromCustomer: m.direction !== 'outbound',
          text: (m.body ?? m.messageType ?? '').toString().slice(0, 500),
        }))
        .filter((m) => m.text);
    } catch {
      recentMessages = [];
    }
  }

  const { system, user } = buildDraftPrompt({
    customerName: item.customerName,
    source: item.source,
    channel: item.channel,
    recentMessages,
    quoteTotal: item.quoteTotal,
  });

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    const draft = block && block.type === 'text' ? block.text.trim() : '';
    if (!draft) return NextResponse.json({ error: 'No draft produced' }, { status: 502 });
    return NextResponse.json({ ok: true, draft });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 200) : 'Draft failed' },
      { status: 502 },
    );
  }
}
