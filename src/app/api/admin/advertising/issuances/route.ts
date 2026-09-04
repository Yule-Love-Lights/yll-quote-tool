import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import {
  getWorkerSignBalance,
  isIssuanceKind,
  issueSigns,
  listIssuances,
  type IssuanceKind,
} from '@/lib/advertising/signIssuances';
import { listAdvertisingWorkers } from '@/lib/advertising/workers';

export const runtime = 'nodejs';

/**
 * Sign allotments (Naldo 2026-08-29): hand a worker a stack of signs; their
 * balance draws down as yard-sign photos come in.
 *
 *   GET  /api/admin/advertising/issuances            — every worker's balance
 *   GET  /api/admin/advertising/issuances?workerId=x — one worker's balance +
 *        issuance history
 *   POST /api/admin/advertising/issuances            — { workerId, qty, note? }
 *
 * requireAdmin only. The balance never GATES a submission — a photo of a
 * standing sign must never be refused over bookkeeping.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const workerId = (req.nextUrl.searchParams.get('workerId') ?? '').trim();
  const rawKind = req.nextUrl.searchParams.get('kind');
  const kind: IssuanceKind = isIssuanceKind(rawKind) ? rawKind : 'yard_sign';

  if (workerId) {
    const [balance, issuances] = await Promise.all([
      getWorkerSignBalance(workerId, kind),
      listIssuances(workerId, kind),
    ]);
    return NextResponse.json({ balance, issuances });
  }

  const workers = await listAdvertisingWorkers({ includeInactive: true });
  const balances = await Promise.all(
    workers.map(async (w) => ({
      ...(await getWorkerSignBalance(w.id, kind)),
      displayName: w.displayName,
      active: w.active,
      isTest: w.isTest,
    })),
  );
  return NextResponse.json({ balances });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { workerId?: unknown; qty?: unknown; note?: unknown; requestId?: unknown; kind?: unknown }
    | null;
  const workerId = String(body?.workerId ?? '').trim();
  const qty = body?.qty;
  if (!workerId) return NextResponse.json({ error: 'Choose a worker.' }, { status: 400 });
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
    return NextResponse.json(
      { error: 'Send qty as a whole number of signs, 1 or more.' },
      { status: 400 },
    );
  }

  try {
    // One id per confirmed hand-out (ledger row 480). Validated as a uuid so
    // a malformed value is refused rather than silently stored, which would
    // hand back a key that guards nothing.
    const rawId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';
    const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)
      ? rawId
      : undefined;
    if (rawId && !requestId) {
      return NextResponse.json({ error: 'Bad request id.' }, { status: 400 });
    }
    const kind: IssuanceKind = isIssuanceKind(body?.kind) ? body.kind : 'yard_sign';
    await issueSigns(
      workerId,
      qty,
      auth.operator.id,
      typeof body?.note === 'string' ? body.note : undefined,
      requestId,
      kind,
    );
    const balance = await getWorkerSignBalance(workerId, isIssuanceKind(body?.kind) ? body.kind : 'yard_sign');
    return NextResponse.json({ balance }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not record the issuance';
    console.error('POST /api/admin/advertising/issuances:', message);
    const bad = /quantity/i.test(message);
    return NextResponse.json(
      { error: bad ? 'Issue a whole number of signs, 1 or more.' : 'Could not record the issuance. Try again.' },
      { status: bad ? 400 : 500 },
    );
  }
}
