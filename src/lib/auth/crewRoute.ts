import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { CREW_COOKIE_NAME, crewRefusalStatus, resolveCrewCaller } from '@/lib/auth/crewSession';
import type { CrewMember } from '@/lib/crewMembers';

/**
 * The one door into every /api/crew route.
 *
 * The perimeter (operatorGate) lets the whole /api/crew namespace through
 * because a crew session is an httpOnly cookie the proxy cannot read, which
 * means each route has to guard itself. A future route added to that namespace
 * without a guard would be public, so the guard is a WRAPPER rather than a call
 * each handler must remember: `crewNamespace.test.ts` asserts every route file
 * under src/app/api/crew uses it (technical lens, PR #1094).
 */
export function withCrewSession(
  handler: (member: CrewMember) => Promise<NextResponse>,
): () => Promise<NextResponse> {
  return async () => {
    const store = await cookies();
    const caller = await resolveCrewCaller(store.get(CREW_COOKIE_NAME)?.value);
    if (!caller.ok) {
      return NextResponse.json({ error: caller.reason }, { status: crewRefusalStatus(caller.reason) });
    }
    return handler(caller.member);
  };
}
