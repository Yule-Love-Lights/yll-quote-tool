import { NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { getWorkerPayoutSummary, listSettlements } from '@/lib/advertising/payouts';

export const runtime = 'nodejs';

/**
 * GET /api/advertising/settlements — the worker's own payment history
 * (Naldo 2026-08-30: they see every payment, not just a running total,
 * because that is what settles a "you never paid me for that week"
 * conversation). Always scoped to the SESSION worker; there is no id in the
 * request, so one worker can never read another's money.
 */
export async function GET() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  try {
    const [summary, settlements] = await Promise.all([
      getWorkerPayoutSummary(caller.worker.id),
      listSettlements(caller.worker.id),
    ]);

    // REDACT at the boundary, not in the shared type (customer lens, PR
    // #1136). A settlement carries fields written for the office: the admin
    // ids that recorded and undid it, and the free-text reason for undoing
    // it. The Undo prompt asks "Why?" with nothing saying it is shown to the
    // worker, so the office reasonably writes it for a colleague. Declaring
    // a narrower type on the client does NOT keep those fields off the wire;
    // only this does. The worker gets what they need: what they were paid,
    // when, how, the note the office knowingly writes for them, and whether
    // it was later undone.
    const safe = settlements.map((s) => ({
      id: s.id,
      totalCents: s.totalCents,
      method: s.method,
      note: s.note,
      paidAt: s.paidAt,
      lineCount: s.lineCount,
      voidedAt: s.voidedAt,
    }));
    return NextResponse.json({ summary, settlements: safe });
  } catch (e) {
    // Say the read failed rather than returning zeros, which a worker would
    // read as "they have paid me nothing".
    console.error('GET /api/advertising/settlements:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load your payments.' }, { status: 500 });
  }
}
