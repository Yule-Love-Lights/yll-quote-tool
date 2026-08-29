import { NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { earningsSummary, listPlacements, type WorkerEarningsSummary } from '@/lib/advertising/placements';
import { listRateChangeEvents } from '@/lib/advertising/activity';
import { hasPendingRateChange } from '@/lib/advertising/rateChangeNote';

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

  // "Rate changed since you placed these" (ops suggestions round): pending
  // money is an estimate at the CURRENT rate, so if any campaign's rate
  // changed after one of this worker's pending rows was captured, say so
  // instead of letting the number move silently. Best effort: a failed read
  // means no note, never an error on the money view.
  // Bounded read, accepted deliberately (technical lens LOW): the newest 500
  // rows of ONE worker; a still-pending row older than a worker's 500 most
  // recent placements could miss the note. The note is advisory, the money
  // math itself pages to completeness in earningsSummary. Also accepted: a
  // rate round trip (A to B back to A) still shows the note, because the
  // capture-time rate is not stored to compare against; the copy stays true
  // either way (the estimate DID move in between).
  const own = await listPlacements({ workerId: caller.worker.id });
  const pendingTimes = own
    .filter((p) => !p.isTest && (p.status === 'pending' || p.status === 'resubmitted'))
    .map((p) => ({ campaignId: p.campaignId, at: p.capturedAt ?? p.createdAt }));
  let rateChangedSincePending = false;
  if (pendingTimes.length > 0) {
    const earliest = pendingTimes
      .map((p) => Date.parse(p.at))
      .filter((t) => !Number.isNaN(t))
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    if (Number.isFinite(earliest)) {
      const events = await listRateChangeEvents(
        [...new Set(pendingTimes.map((p) => p.campaignId))],
        new Date(earliest).toISOString(),
      );
      rateChangedSincePending = hasPendingRateChange(pendingTimes, events);
    }
  }

  return NextResponse.json({ summary, rateChangedSincePending });
}
