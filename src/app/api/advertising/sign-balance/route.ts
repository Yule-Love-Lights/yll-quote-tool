import { NextResponse } from 'next/server';

import { advertisingRefusalStatus, getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { getWorkerSignBalance } from '@/lib/advertising/signIssuances';

export const runtime = 'nodejs';

/**
 * GET /api/advertising/sign-balance — the crew's own remaining signs.
 *
 * The admin issuances route returns EVERY worker and is requireAdmin, so
 * crew get their own door here, scoped to the SESSION worker: the id is
 * never taken from the request, so one worker cannot read another's
 * balance.
 *
 * The balance INFORMS, it never gates: a worker at zero still submits
 * normally, because a photo of a standing sign must not be refused over
 * bookkeeping. A failed read returns an error rather than a zero, since a
 * confident "0 left" would read as a real count.
 */
export async function GET() {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    return NextResponse.json({ error: 'Not allowed' }, { status: advertisingRefusalStatus(caller.reason) });
  }

  try {
    const balance = await getWorkerSignBalance(caller.worker.id);
    return NextResponse.json({ balance });
  } catch (e) {
    console.error('GET /api/advertising/sign-balance:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not read your sign count.' }, { status: 502 });
  }
}
