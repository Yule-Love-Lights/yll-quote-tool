import { NextResponse } from 'next/server';

import { withCrewSession } from '@/lib/auth/crewRoute';
import { businessToday, getMyDay } from '@/lib/crew/myDay';

export const dynamic = 'force-dynamic';

/** Today's assignments for the crew member holding the session cookie. Read
 * only, and money-free by the shape it returns (see lib/crew/myDay.ts). */
export const GET = withCrewSession(async (member) => {
  const date = businessToday();
  const items = await getMyDay(member.id, date);
  return NextResponse.json({
    date,
    crewMember: { id: member.id, displayName: member.displayName },
    items,
  });
});
