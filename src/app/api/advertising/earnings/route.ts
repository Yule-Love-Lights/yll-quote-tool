import { NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { earningsSummary, type WorkerEarningsSummary } from '@/lib/advertising/placements';

export const runtime = 'nodejs';

const EMPTY: Omit<WorkerEarningsSummary, 'workerId'> = {
  total: { pendingEstimatedCents: 0, acceptedEarnedCents: 0 },
  byDay: [],
  byWeek: [],
};

/**
 * GET /api/advertising/earnings — the caller's own money view: pending
 * estimated cents (pending + resubmitted placements, any kind, at the
 * campaign's current rate) and accepted earned cents (the stamped rates,
 * per accepted photo), with ET day and week
 * groupings. Always scoped to the SESSION worker.
 */
export async function GET() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const summaries = await earningsSummary({ workerId: caller.worker.id });
  const summary = summaries.find((s) => s.workerId === caller.worker.id) ?? {
    workerId: caller.worker.id,
    ...EMPTY,
  };
  return NextResponse.json({ summary });
}
