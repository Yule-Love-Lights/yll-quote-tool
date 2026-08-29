import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { CREW_COOKIE_NAME, crewRefusalStatus, resolveCrewCaller } from '@/lib/auth/crewSession';
import { businessToday, getMyDay } from '@/lib/crew/myDay';

export const dynamic = 'force-dynamic';

/** Today's assignments for the crew member holding the session cookie. Read
 * only, and money-free by the shape it returns (see lib/crew/myDay.ts). */
export async function GET() {
  const store = await cookies();
  const caller = await resolveCrewCaller(store.get(CREW_COOKIE_NAME)?.value);
  if (!caller.ok) {
    return NextResponse.json({ error: caller.reason }, { status: crewRefusalStatus(caller.reason) });
  }

  const date = businessToday();
  const items = await getMyDay(caller.member.id, date);
  return NextResponse.json({ date, crewMember: { id: caller.member.id, displayName: caller.member.displayName }, items });
}
