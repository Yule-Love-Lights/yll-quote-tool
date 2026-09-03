import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import {
  isSettlementMethod,
  listPayablePlacements,
  listPayoutSummaries,
  listSettlements,
  recordSettlement,
} from '@/lib/advertising/payouts';
import { listAdvertisingWorkers } from '@/lib/advertising/workers';

export const runtime = 'nodejs';

/**
 * Advertising payout settlement (ledger row 481).
 *
 *   GET  /api/admin/advertising/settlements            — every worker's
 *        earned / paid / unpaid, with what is payable right now
 *   GET  /api/admin/advertising/settlements?workerId=x — one worker's numbers
 *        plus their payment history
 *   POST /api/admin/advertising/settlements            — record a payment:
 *        { workerId, method, note?, expectedTotalCents }
 *
 * requireAdmin only, and the payer is ALWAYS the admin session — never a
 * value from the body, which would let the record name someone who was not
 * there. The photos being paid are chosen SERVER-side (everything still
 * outstanding, Naldo 2026-08-30); the body carries only the amount the
 * screen showed, and a mismatch is refused rather than quietly paying a
 * different number than the one the office just confirmed.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const workerId = (req.nextUrl.searchParams.get('workerId') ?? '').trim();
  const workers = await listAdvertisingWorkers({ includeInactive: true });
  const nameById = new Map(workers.map((w) => [w.id, w.displayName]));

  try {
    if (workerId) {
      const [summaries, payable, history] = await Promise.all([
        listPayoutSummaries(),
        listPayablePlacements(workerId),
        listSettlements(workerId),
      ]);
      const summary = summaries.find((s) => s.workerId === workerId) ?? {
        workerId,
        earnedCents: 0,
        settledCents: 0,
        unpaidCents: 0,
        lastPaidAt: null,
        payableCount: 0,
      };
      return NextResponse.json({
        worker: {
          ...summary,
          displayName: nameById.get(workerId) ?? '(unknown worker)',
          payableTotalCents: payable.reduce((sum, p) => sum + p.amountCents, 0),
        },
        settlements: history,
      });
    }

    const summaries = await listPayoutSummaries();
    const workersOut = await Promise.all(
      summaries.map(async (summary) => {
        const [payable, settlements] = await Promise.all([
          listPayablePlacements(summary.workerId),
          listSettlements(summary.workerId),
        ]);
        return {
          ...summary,
          displayName: nameById.get(summary.workerId) ?? '(unknown worker)',
          payableTotalCents: payable.reduce((sum, p) => sum + p.amountCents, 0),
          // The payments themselves, so the screen can show what was paid
          // and offer to undo one (ledger row 492). Voided ones are included
          // and marked; they count for nothing but the record survives.
          settlements,
        };
      }),
    );
    return NextResponse.json({ workers: workersOut });
  } catch (e) {
    // A money read that fails must SAY so; an empty list here would read as
    // "nobody is owed anything", which is the worst possible lie on this
    // screen.
    console.error('GET /api/admin/advertising/settlements:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load pay.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { workerId?: unknown; method?: unknown; note?: unknown; expectedTotalCents?: unknown }
    | null;
  const workerId = String(body?.workerId ?? '').trim();
  const method = body?.method;
  const expected = body?.expectedTotalCents;

  if (!workerId) return NextResponse.json({ error: 'Choose a worker.' }, { status: 400 });
  if (!isSettlementMethod(method)) {
    return NextResponse.json({ error: 'Choose how the money was paid.' }, { status: 400 });
  }
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected <= 0) {
    return NextResponse.json({ error: 'Send the amount shown on screen, in whole cents.' }, { status: 400 });
  }

  try {
    const payable = await listPayablePlacements(workerId);
    if (payable.length === 0) {
      return NextResponse.json({ error: 'There is nothing outstanding for this worker.' }, { status: 409 });
    }
    const totalCents = payable.reduce((sum, p) => sum + p.amountCents, 0);
    if (totalCents !== expected) {
      // A photo was accepted, voided or paid between the screen loading and
      // this click. Pay the number the office actually agreed to, or none.
      return NextResponse.json(
        { error: 'The amount changed while you were on this screen. Reload and check it before paying.' },
        { status: 409 },
      );
    }

    const settlement = await recordSettlement(
      workerId,
      payable.map((p) => p.id),
      auth.operator.id,
      { method, note: typeof body?.note === 'string' ? body.note : undefined },
    );
    return NextResponse.json({ settlement }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not record the payment';
    console.error('POST /api/admin/advertising/settlements:', message);

    // The one outcome that needs a person rather than a retry: the payment
    // was recorded, a photo was voided underneath it, and the unwind could
    // not remove the row. Paid and earned now disagree for that worker until
    // someone fixes it, so say exactly that and name the row. "Try again"
    // would be useless advice here. (Delta-verify, PR #1130.)
    if (/reconciled by hand/i.test(message)) {
      return NextResponse.json({ error: message.replace(/^recordSettlement:\s*/, '') }, { status: 500 });
    }

    const conflict = /already been paid|paid a moment ago|nothing to pay|test worker|voided/i.test(message);
    return NextResponse.json(
      {
        error: conflict
          ? 'That payment could not be recorded: something changed. Reload the pay screen and check before paying.'
          : 'Could not record the payment. Try again.',
      },
      { status: conflict ? 409 : 500 },
    );
  }
}
