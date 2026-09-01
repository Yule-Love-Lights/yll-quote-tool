// /admin/fleet is now a redirect (Naldo, 2026-08-31).
//
// The fleet live view moved wholesale into the right column of the Schedule
// page and lost its own nav tab. Nothing was deleted: the map, the vehicle
// list, the van-is-not-the-person caveat and the admin links all render there
// (src/components/admin/FleetPanel.tsx). This route stays so the bookmarks,
// the in-app links and the non-admin exit from /admin/fleet/clocks all land
// somewhere real instead of on a 404.

import { redirect } from 'next/navigation';

import { etDayKey } from '@/lib/dashboard/inbox/normalize';

export const dynamic = 'force-dynamic';

export default async function FleetPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const today = etDayKey(new Date());

  // A ?date= bookmark asked about a PAST day, and the schedule's day picker is
  // client state with no URL of its own, so sending it to the schedule would
  // silently answer a different question than the one asked (row 457b, which
  // fixed exactly that). The two-clocks page is the surface that still takes a
  // date; it gates on admin itself and sends anyone else back here, which
  // lands them on the schedule one hop later.
  if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && rawDate !== today) {
    redirect(`/admin/fleet/clocks?date=${rawDate}`);
  }

  redirect('/admin/schedule');
}
