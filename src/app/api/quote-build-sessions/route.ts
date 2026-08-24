import { NextResponse } from 'next/server';

import { getOperator } from '@/lib/auth/supabaseServer';
import {
  completeQuoteBuildSession,
  getOwnedQuoteBuildSession,
  linkQuoteBuildSession,
  quoteBuildSessionTargetState,
  startQuoteBuildSession,
} from '@/lib/quoteBuildTiming';
import type { QuoteBuildStartReason } from '@/lib/quoteBuildTimerClient';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const START_REASONS: QuoteBuildStartReason[] = ['contact_selected', 'prefilled_open'];

export async function POST(req: Request) {
  const startedAt = new Date().toISOString();
  const operator = await getOperator();
  if (!operator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { timerId, startReason, quoteId } = body as Record<string, unknown>;
  if (typeof timerId !== 'string' || !UUID_RE.test(timerId)) {
    return NextResponse.json({ error: 'timerId must be a valid UUID' }, { status: 400 });
  }
  if (typeof startReason !== 'string' || !START_REASONS.includes(startReason as QuoteBuildStartReason)) {
    return NextResponse.json({ error: 'startReason must be contact_selected or prefilled_open' }, { status: 400 });
  }
  if (quoteId !== undefined && (typeof quoteId !== 'string' || !UUID_RE.test(quoteId))) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID if provided' }, { status: 400 });
  }
  const targetState = typeof quoteId === 'string'
    ? await quoteBuildSessionTargetState(quoteId)
    : null;
  if (typeof quoteId === 'string') {
    if (targetState === null) {
      return NextResponse.json({ error: 'Failed to verify quote for timing' }, { status: 500 });
    }
    if (targetState.kind === 'ineligible') {
      return NextResponse.json({ error: 'Only real, editable draft quotes can be timed' }, { status: 409 });
    }
  }

  const existingSentTimer = targetState?.kind === 'sent'
    ? await getOwnedQuoteBuildSession({ timerId, operatorId: operator.id })
    : null;
  const requestPredatesSend = targetState?.kind === 'sent' &&
    Number.isFinite(Date.parse(targetState.sentAt)) &&
    Date.parse(startedAt) < Date.parse(targetState.sentAt);
  const started = targetState?.kind === 'sent'
    ? existingSentTimer
      ? { ok: true as const, kind: 'existing' as const, row: existingSentTimer }
      : requestPredatesSend
        ? await startQuoteBuildSession({
            timerId,
            startReason: startReason as QuoteBuildStartReason,
            operator,
            quoteId: quoteId as string,
            startedAt,
          })
        : { ok: false as const, kind: 'conflict' as const }
    : await startQuoteBuildSession({
        timerId,
        startReason: startReason as QuoteBuildStartReason,
        operator,
        ...(typeof quoteId === 'string' ? { quoteId } : {}),
        startedAt,
      });
  if (!started.ok) {
    return NextResponse.json(
      { error: started.kind === 'conflict' ? 'Timer belongs to another staff member' : 'Failed to start timer' },
      { status: started.kind === 'conflict' ? 409 : 500 },
    );
  }

  let linked = false;
  if (typeof quoteId === 'string' && targetState) {
    if (started.row.id !== timerId) {
      return NextResponse.json({ error: 'This quote already has another timer' }, { status: 409 });
    }
    if (started.row.quote_id != null && started.row.quote_id !== quoteId) {
      return NextResponse.json({ error: 'Timer is already linked to another quote' }, { status: 409 });
    }
    if (started.row.quote_id === quoteId && started.row.sent_at != null) {
      linked = true;
    } else if (targetState.kind === 'sent') {
      linked = await completeQuoteBuildSession({
        quoteId,
        timerId,
        operatorId: operator.id,
        sentAt: targetState.sentAt,
      });
    } else {
      linked = started.row.quote_id === quoteId || await linkQuoteBuildSession({
        timerId,
        quoteId,
        operatorId: operator.id,
      });
      if (linked) {
        const latestTarget = await quoteBuildSessionTargetState(quoteId);
        if (latestTarget?.kind === 'sent') {
          await completeQuoteBuildSession({
            quoteId,
            timerId,
            operatorId: operator.id,
            sentAt: latestTarget.sentAt,
          });
        }
      }
    }
    if (!linked) {
      return NextResponse.json({ error: 'Timer could not be linked to this quote' }, { status: 409 });
    }
  }

  return NextResponse.json({ ok: true, timerId, linked });
}
