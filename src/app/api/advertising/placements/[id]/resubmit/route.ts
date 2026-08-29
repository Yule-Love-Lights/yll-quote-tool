import { NextResponse, type NextRequest } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { getPlacement, resubmitPlacement } from '@/lib/advertising/placements';

export const runtime = 'nodejs';

/**
 * POST /api/advertising/placements/[id]/resubmit — the one transition a
 * WORKER may perform: ask for another look at their own REJECTED placement.
 * Ownership comes from the session; a placement that is not the caller's
 * 404s so existence is not leaked. The data layer's CAS (status='rejected')
 * is what actually guards the state machine.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  const { id } = await ctx.params;
  const placement = await getPlacement(id);
  if (!placement || placement.workerId !== caller.worker.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const resubmitted = await resubmitPlacement(id);
    return NextResponse.json({ placement: resubmitted });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not resubmit';
    // The data layer names the state it refused; that is a conflict, not a crash.
    const conflict = /is '|only rejected|voided/.test(message);
    console.error('POST /api/advertising/placements/[id]/resubmit:', message);
    return NextResponse.json(
      {
        error: conflict
          ? /voided/.test(message)
            ? 'This placement was voided by the office and cannot be resubmitted. Take a fresh photo if the sign still stands.'
            : 'Only a rejected placement can be resubmitted.'
          : 'Could not resubmit. Try again.',
      },
      { status: conflict ? 409 : 500 },
    );
  }
}
