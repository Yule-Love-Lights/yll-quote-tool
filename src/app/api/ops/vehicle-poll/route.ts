// src/app/api/ops/vehicle-poll/route.ts — the fleet position poll (row 403).
//
// Vercel Cron, every 2 minutes. CRON_SECRET-guarded like its siblings, and
// allowlisted in `operatorGate.ts` for the same reason they all are: a cron
// request carries no operator session, so without the perimeter entry it would
// be 401'd before this guard ever ran.
//
// Cheap by design: one Bouncie call per cycle for the whole fleet, a handful of
// small reads, and writes only when something changed. It runs even on days
// with no jobs, deliberately — the call is what keeps the OAuth grant's refresh
// token from expiring through disuse (ledger row 430), and the position columns
// keep the map honest on quiet days.
//
// Deliberately NOT under /api/ops/v1: that prefix is the crew surface.

import { NextRequest, NextResponse } from 'next/server';
import { cronDenial } from '@/lib/auth/cronAuth';
import { pollVehiclePositions } from '@/lib/integrations/vehicleProximity';
import { isBouncieOAuthConfigured } from '@/lib/integrations/bouncieAuth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;

  // Dormant until the OAuth env vars exist — a 200 no-op, not an error, so the
  // cron does not spend its life logging failures on a feature that is not
  // switched on yet.
  if (!isBouncieOAuthConfigured()) {
    // Logged, not just returned (S68 admin lens): a dormant cron that answers a
    // silent 200 every two minutes forever is exactly the silence-looks-like-
    // success failure this route's own summary line exists to prevent. One info
    // line per cycle is cheap; believing tracking is on when it is not is not.
    console.info('[vehicle-poll] dormant: Bouncie OAuth env vars not configured, nothing polled');
    return NextResponse.json({ ok: true, dormant: 'bouncie oauth not configured' });
  }

  const outcome = await pollVehiclePositions();

  // A cycle with errors logs loudly; a clean quiet cycle logs one line. The
  // geofence draft's lesson: a run that did nothing must never look identical
  // to a run that worked.
  const line = `[vehicle-poll] polled ${outcome.polled}, opened ${outcome.opened}, closed ${outcome.closed}, noSignal ${outcome.noSignal}, errors ${outcome.errors.length}`;
  if (outcome.errors.length) console.error(line, outcome.errors);
  else console.info(line);

  return NextResponse.json({ ok: outcome.errors.length === 0, ...outcome });
}
