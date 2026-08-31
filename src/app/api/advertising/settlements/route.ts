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
    return NextResponse.json({ summary, settlements });
  } catch (e) {
    // Say the read failed rather than returning zeros, which a worker would
    // read as "they have paid me nothing".
    console.error('GET /api/advertising/settlements:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not load your payments.' }, { status: 500 });
  }
}
